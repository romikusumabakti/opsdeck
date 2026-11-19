import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkReadOnlyQuery } from "@/lib/assistant-db/gate";
import { pgEnableAssistantDbPipeline } from "@/lib/assistant-db/provision";
import { assistantQueryCommand, parsePsqlCsv } from "@/lib/assistant-db/query";

// The Assistant's query path on a real Postgres (Stage 9 spec F.2/F.3): the
// exact `docker exec … psql` command the tool sends, run against the local
// menara-postgres container as the environment's read-only role. The role's
// own ALTER ROLE can't switch read-only or the timeout off for the query
// (PGOPTIONS wins), the row cap holds, and the CSV parser keeps NULL, empty
// strings, commas, quotes and line breaks apart. Everything is named
// cnry_q_* and dropped.
//
//   ASSISTANT_DB_SCRATCH=1 bun --bun vitest run tests/assistant-db-query-scratch.test.ts
const enabled = process.env.ASSISTANT_DB_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const ENV_ID = "0197f3a0-1b2c-7def-8000-00000000e0e1";
const DB = "cnry_q_a";
const APP = "cnry_q_app";
const RO = "menara_ro_cnry_q_a";

type Result = { code: number; stdout: string; stderr: string };

function run(command: string, args: string[], stdin?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d;
    });
    proc.stderr?.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) proc.stdin?.end(stdin);
  });
}

const superuser = (sql: string, database = "postgres") =>
  run("podman", [
    "exec",
    CONTAINER,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    database,
    "-Atc",
    sql,
  ]);

const LOGIN = {
  engine: "postgres" as const,
  serviceId: "svc",
  login: RO,
  database: DB,
};
const SERVICE = {
  serviceType: "docker",
  serviceName: CONTAINER,
  server: {
    id: "srv",
    host: "db.example.invalid",
    username: "ops",
    password: null,
    auth: "key",
  },
} as unknown as Parameters<typeof assistantQueryCommand>[1];

/** The tool's own command, run locally (`docker` is the podman wrapper). */
async function query(sql: string, rowLimit = 101) {
  const { command } = assistantQueryCommand(LOGIN, SERVICE, sql, rowLimit);
  const result = await run("bash", [
    "-c",
    command.replace(/^docker /, "podman "),
  ]);
  return { ...result, parsed: parsePsqlCsv(result.stdout) };
}

async function cleanup() {
  await superuser(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  for (const role of [RO, APP]) {
    await superuser(`DROP ROLE IF EXISTS ${role}`);
  }
}

describe.skipIf(!enabled)("assistant query path on Postgres", () => {
  beforeAll(async () => {
    await cleanup();
    expect((await superuser(`CREATE ROLE ${APP} LOGIN`)).code).toBe(0);
    expect((await superuser(`CREATE DATABASE ${DB} OWNER ${APP}`)).code).toBe(
      0
    );
    const setup = await superuser(
      `SET ROLE ${APP}; CREATE TABLE members (id int, email text, note text, gone text); INSERT INTO members VALUES (1, 'a@example.invalid', 'x,"y' || chr(10) || 'z', NULL), (2, 'b@example.invalid', '', 'NULL'); INSERT INTO members SELECT g, 'm' || g || '@example.invalid', 'n', 'v' FROM generate_series(3, 150) g;`,
      DB
    );
    expect(setup.code, setup.stderr).toBe(0);
    const enabledRole = await run("podman", [
      "exec",
      CONTAINER,
      "bash",
      "-c",
      pgEnableAssistantDbPipeline({
        database: DB,
        role: RO,
        environmentId: ENV_ID,
        appRoles: [APP],
        adopt: false,
      }),
    ]);
    expect(enabledRole.code, enabledRole.stderr).toBe(0);
  });
  afterAll(cleanup);

  it("reads as the read-only role and keeps NULL, empty strings and line breaks apart", async () => {
    const gate = checkReadOnlyQuery(
      "SELECT id, note, gone FROM members WHERE id <= 2 ORDER BY id",
      "postgres"
    );
    expect(gate.ok).toBe(true);
    const result = await query(gate.ok ? gate.normalized : "");
    expect(result.code, result.stderr).toBe(0);
    expect(result.parsed).toEqual({
      columns: ["id", "note", "gone"],
      rows: [
        ["1", 'x,"y\nz', null],
        ["2", "", "NULL"],
      ],
    });
    const who = await query("SELECT current_user AS who");
    expect(who.parsed.rows).toEqual([[RO]]);
  });

  it("caps the rows, keeps a CTE's order and duplicate column names", async () => {
    const capped = await query("SELECT id FROM members ORDER BY id DESC");
    expect(capped.parsed.rows).toHaveLength(101);
    expect(capped.parsed.rows[0]).toEqual(["150"]);
    const cte = await query(
      "WITH c AS (SELECT id, id AS n FROM members WHERE id < 4) SELECT c.id, m.id FROM c JOIN members m ON m.id = c.n ORDER BY c.id DESC"
    );
    expect(cte.code, cte.stderr).toBe(0);
    expect(cte.parsed).toEqual({
      columns: ["id", "id"],
      rows: [
        ["3", "3"],
        ["2", "2"],
        ["1", "1"],
      ],
    });
  });

  it("stays read-only with a 10 s timeout even after the role reset its own defaults", async () => {
    const reset = await run(
      "podman",
      [
        "exec",
        "-i",
        CONTAINER,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        RO,
        "-d",
        DB,
      ],
      `SET default_transaction_read_only = off; ALTER ROLE ${RO} SET default_transaction_read_only = off; ALTER ROLE ${RO} SET statement_timeout = 0;`
    );
    expect(reset.code, reset.stderr).toBe(0);
    const settings = await query(
      "SELECT current_setting('default_transaction_read_only') AS ro, current_setting('statement_timeout') AS t"
    );
    expect(settings.parsed.rows).toEqual([["on", "10s"]]);
    // The wrapper is a plain SELECT, so a smuggled write has nowhere to go;
    // the read-only transaction refuses one even when sent directly.
    const write = await run("bash", [
      "-c",
      assistantQueryCommand(LOGIN, SERVICE, "SELECT 1", 1)
        .command.replace(/^docker /, "podman ")
        .replace(
          "SELECT * FROM (SELECT 1) AS menara_q LIMIT 1",
          "CREATE TEMP TABLE t (x int)"
        ),
    ]);
    expect(write.code).not.toBe(0);
    expect(write.stderr).toMatch(/read-only transaction/);
  });

  it("returns the engine's error for a bad query", async () => {
    const result = await query("SELECT id FROM no_such_table");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/relation "no_such_table" does not exist/);
  });
});
