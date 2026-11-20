import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  pgAssistantDbAdminPsql,
  pgAssistantDbCheckCommand,
  pgDisableAssistantDbPipeline,
  pgEnableAssistantDbPipeline,
  pgEnableAssistantDbSql,
} from "@/lib/assistant-db/provision";
import { scramSha256Verifier } from "@/lib/assistant-db/scram";

// The Assistant's read-only Postgres role on a real cluster (Stage 9 spec
// F.2, Review Focus 2): two databases on one host, like a shared database
// host. The role reads its own environment's database, including tables and
// schemas made after enabling; it can CONNECT to the other database (PUBLIC
// keeps CONNECT there by design) but reads none of its tables; every write
// or privileged attempt fails, even with read-only switched off in the
// session; disabling drops it. The shell pipelines run in the local
// menara-postgres container exactly as `docker exec … bash -c` would run
// them. Everything is named cnry_ro_* and dropped.
//
//   ASSISTANT_DB_SCRATCH=1 bun --bun vitest run tests/assistant-db-provision-scratch.test.ts
const enabled = process.env.ASSISTANT_DB_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const ENV_A = "0197f3a0-1b2c-7def-8000-00000000a0a1";
const ENV_C = "0197f3a0-1b2c-7def-8000-00000000c0c1";
const DB_A = "cnry_ro_a";
const DB_B = "cnry_ro_b";
const DB_C = "cnry_ro_c";
const APP_A = "cnry_ro_app_a";
const APP_B = "cnry_ro_app_b";
const RO_A = "menara_ro_cnry_ro_a";
const RO_C = "menara_ro_cnry_ro_c";

type Result = { code: number; stdout: string; stderr: string };

function run(args: string[], stdin?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn("podman", args, {
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
    proc.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
    );
    if (stdin !== undefined) proc.stdin?.end(stdin);
  });
}

const shell = (script: string) =>
  run(["exec", CONTAINER, "bash", "-c", script]);
const superuser = (sql: string, database = "postgres") =>
  run([
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
// As an app role (SET ROLE), so its objects are owned by it.
const asApp = (role: string, database: string, sql: string) =>
  superuser(`SET ROLE ${role}; ${sql}`, database);
// As the read-only role over the local socket, several statements allowed:
// what a bypassed SQL parser would let through.
const asRo = (sql: string, database = DB_A, role = RO_A) =>
  run(
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-X",
      "-q",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      role,
      "-d",
      database,
    ],
    sql
  );

// `adopt`: the environment records the role as its own (a re-enable).
const enable = (
  database: string,
  role: string,
  environmentId: string,
  appRoles: string[] = [],
  adopt = false
) =>
  shell(
    pgEnableAssistantDbPipeline({
      database,
      role,
      environmentId,
      appRoles,
      adopt,
    })
  );
const disable = (database: string, role: string, environmentId: string) =>
  shell(pgDisableAssistantDbPipeline({ database, role, environmentId }));

async function cleanup() {
  for (const db of [DB_A, DB_B, DB_C]) {
    await superuser(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  }
  for (const role of [RO_A, RO_C, APP_A, APP_B]) {
    await superuser(`DROP ROLE IF EXISTS ${role}`);
  }
}

describe.skipIf(!enabled)("assistant read-only role on Postgres", () => {
  beforeAll(async () => {
    await cleanup();
    for (const [role, db] of [
      [APP_A, DB_A],
      [APP_B, DB_B],
    ] as const) {
      expect((await superuser(`CREATE ROLE ${role} LOGIN`)).code).toBe(0);
      expect(
        (await superuser(`CREATE DATABASE ${db} OWNER ${role}`)).code
      ).toBe(0);
      // As lib/provisioning/database does for a shared database.
      await superuser(
        `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`
      );
    }
    // PG15+ makes the database owner own `public` (pg_database_owner).
    expect(
      (
        await asApp(
          APP_A,
          DB_A,
          "CREATE TABLE members (id int, name text); INSERT INTO members VALUES (1, 'Fictional Member'); CREATE SCHEMA ledger; CREATE TABLE ledger.entries (id int, amount int); INSERT INTO ledger.entries VALUES (1, 100); CREATE VIEW member_names AS SELECT name FROM members;"
        )
      ).code
    ).toBe(0);
    expect(
      (
        await asApp(
          APP_B,
          DB_B,
          "CREATE TABLE other_members (id int, name text); INSERT INTO other_members VALUES (7, 'Other Environment');"
        )
      ).code
    ).toBe(0);
    // A table postgres itself made in A: still readable.
    expect(
      (
        await superuser(
          "CREATE TABLE admin_made (x int); INSERT INTO admin_made VALUES (5);",
          DB_A
        )
      ).code
    ).toBe(0);
  });
  afterAll(cleanup);

  it("creates the role: unprivileged, no memberships, read-only and 10 s", async () => {
    const created = await enable(DB_A, RO_A, ENV_A, [APP_A]);
    expect(created).toMatchObject({ code: 0 });
    const role = await superuser(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolpassword IS NULL, rolconnlimit, shobj_description(oid, 'pg_authid') FROM pg_authid WHERE rolname = '${RO_A}'`
    );
    expect(role.stdout).toBe(`t|f|f|f|f|f|f|t|5|menara:${ENV_A}`);
    expect(
      (
        await superuser(
          `SELECT count(*) FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = '${RO_A}')`
        )
      ).stdout
    ).toBe("0");
    const settings = await asRo(
      "SHOW default_transaction_read_only; SHOW statement_timeout;"
    );
    expect(settings).toMatchObject({ code: 0, stdout: "on\n10s" });
    expect((await shell(pgAssistantDbCheckCommand(RO_A, DB_A))).stdout).toBe(
      "1"
    );
  });

  it("reads its own database: tables, views, other schemas, admin-made tables", async () => {
    const read = await asRo(
      "SELECT name FROM members; SELECT amount FROM ledger.entries; SELECT name FROM member_names; SELECT x FROM admin_made;"
    );
    expect(read).toMatchObject({
      code: 0,
      stdout: "Fictional Member\n100\nFictional Member\n5",
    });
  });

  it("keeps reading tables and schemas the app makes after enabling", async () => {
    expect(
      (
        await asApp(
          APP_A,
          DB_A,
          "CREATE TABLE later (v text); INSERT INTO later VALUES ('new'); CREATE SCHEMA reports; CREATE TABLE reports.monthly (m int); INSERT INTO reports.monthly VALUES (11);"
        )
      ).code
    ).toBe(0);
    expect(
      await asRo("SELECT v FROM later; SELECT m FROM reports.monthly;")
    ).toMatchObject({ code: 0, stdout: "new\n11" });
  });

  it("connects to the other database (PUBLIC CONNECT) but reads none of its tables", async () => {
    // Postgres' default is CONNECT for PUBLIC; B revoked it above, so grant
    // it back for this case, as a host's other databases may well have it.
    await superuser(`GRANT CONNECT ON DATABASE ${DB_B} TO PUBLIC`);
    const connected = await asRo("SELECT current_database();", DB_B);
    expect(connected).toMatchObject({ code: 0, stdout: DB_B });
    const read = await asRo("SELECT name FROM other_members;", DB_B);
    expect(read.code).not.toBe(0);
    expect(read.stderr).toMatch(/permission denied for table other_members/);
    // Without PUBLIC CONNECT it can't even connect.
    await superuser(`REVOKE CONNECT ON DATABASE ${DB_B} FROM PUBLIC`);
    expect((await asRo("SELECT 1;", DB_B)).stderr).toMatch(
      /permission denied for database/
    );
  });

  it("refuses every write and privileged attempt, even with read-only switched off", async () => {
    const insert = await asRo("INSERT INTO members VALUES (2, 'x');");
    expect(insert.stderr).toMatch(/read-only transaction/);
    const attempts: [string, RegExp][] = [
      [
        "SET default_transaction_read_only = off; INSERT INTO members VALUES (2, 'x');",
        /permission denied for table members/,
      ],
      [
        "SELECT set_config('default_transaction_read_only', 'off', false); UPDATE members SET name = 'y';",
        /permission denied for table members/,
      ],
      [
        "SET default_transaction_read_only = off; DELETE FROM ledger.entries;",
        /permission denied for table entries/,
      ],
      [
        "SET default_transaction_read_only = off; TRUNCATE members;",
        /permission denied for table members/,
      ],
      [
        "SET default_transaction_read_only = off; CREATE TABLE public.planted (x int);",
        /permission denied for schema public/,
      ],
      [
        "SET default_transaction_read_only = off; CREATE SCHEMA planted;",
        /permission denied for database/,
      ],
      [
        "SELECT pg_read_file('/etc/hostname');",
        /permission denied for function pg_read_file/,
      ],
      ["SELECT pg_ls_dir('.');", /permission denied for function pg_ls_dir/],
      [
        "SET default_transaction_read_only = off; COPY members TO PROGRAM 'id';",
        /permission denied|must be superuser|pg_execute_server_program/,
      ],
      ["SET ROLE postgres;", /permission denied to set role/],
    ];
    for (const [sql, error] of attempts) {
      const result = await asRo(sql);
      expect(result.code, sql).not.toBe(0);
      expect(result.stderr, sql).toMatch(error);
    }
    expect((await superuser("SELECT count(*) FROM members", DB_A)).stdout).toBe(
      "1"
    );
    expect(
      (await superuser("SELECT count(*) FROM ledger.entries", DB_A)).stdout
    ).toBe("1");
  });

  it("a role may reset its own defaults (Postgres allows it), so the grants stay the barrier; enabling again restores them", async () => {
    // Ordinary roles may ALTER ROLE themselves for user-settable parameters.
    // Only a non-SELECT statement gets there (the query parser refuses it),
    // and even then no write goes through.
    expect(
      (
        await asRo(
          `SET default_transaction_read_only = off; ALTER ROLE ${RO_A} SET default_transaction_read_only = off; ALTER ROLE ${RO_A} SET statement_timeout = 0;`
        )
      ).code
    ).toBe(0);
    expect(await asRo("SHOW default_transaction_read_only;")).toMatchObject({
      stdout: "off",
    });
    const write = await asRo("INSERT INTO members VALUES (3, 'z');");
    expect(write.stderr).toMatch(/permission denied for table members/);
    expect(await enable(DB_A, RO_A, ENV_A, [APP_A], true)).toMatchObject({
      code: 0,
    });
    expect(
      await asRo("SHOW default_transaction_read_only; SHOW statement_timeout;")
    ).toMatchObject({ stdout: "on\n10s" });
  });

  it("is idempotent for the environment's own recorded role", async () => {
    expect(await enable(DB_A, RO_A, ENV_A, [APP_A], true)).toMatchObject({
      code: 0,
    });
    expect(await asRo("SELECT count(*) FROM members;")).toMatchObject({
      code: 0,
      stdout: "1",
    });
  });

  it("never takes over an existing role it doesn't record: hand-made, another environment's, even its own leftover", async () => {
    const roleSettings = () =>
      superuser(
        `SELECT coalesce(string_agg(c, ','), '') FROM pg_db_role_setting, unnest(setconfig) c WHERE setrole = (SELECT oid FROM pg_roles WHERE rolname = '${RO_C}')`
      );
    // Its own marked role, not recorded by the row (a leftover).
    const leftover = await enable(DB_A, RO_A, ENV_A, [APP_A], false);
    expect(leftover.code).not.toBe(0);
    expect(leftover.stderr).toContain("menara-assistant-login-exists");
    // Another environment's, recorded or not.
    for (const adopt of [false, true]) {
      const other = await enable(DB_A, RO_A, ENV_C, [], adopt);
      expect(other.code).not.toBe(0);
      expect(other.stderr).toMatch(
        adopt
          ? /was not created by the Panel for this environment/
          : /menara-assistant-login-exists/
      );
    }
    expect((await disable(DB_A, RO_A, ENV_C)).code).not.toBe(0);
    // A hand-made one keeps everything it had.
    await superuser(`CREATE DATABASE ${DB_C} OWNER ${APP_B}`);
    await superuser(`CREATE ROLE ${RO_C} LOGIN PASSWORD 'hand-Pw-1'`);
    const before = await roleSettings();
    const hand = await enable(DB_C, RO_C, ENV_C);
    expect(hand.code).not.toBe(0);
    expect(hand.stderr).toContain("menara-assistant-login-exists");
    expect(await roleSettings()).toEqual(before);
    expect(
      (
        await superuser(
          `SELECT rolpassword IS NOT NULL, has_database_privilege('${RO_C}', '${DB_C}', 'CONNECT') FROM pg_authid WHERE rolname = '${RO_C}'`
        )
      ).stdout
    ).toBe("t|t");
    await superuser(`DROP ROLE ${RO_C}`);
  });

  it("refuses (and rolls back) a database whose PUBLIC may create or write", async () => {
    await superuser("GRANT CREATE ON SCHEMA public TO PUBLIC", DB_C);
    const refused = await enable(DB_C, RO_C, ENV_C);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/could create objects in schema public/);
    expect(
      (
        await superuser(
          `SELECT count(*) FROM pg_roles WHERE rolname = '${RO_C}'`
        )
      ).stdout
    ).toBe("0");
    await superuser("REVOKE CREATE ON SCHEMA public FROM PUBLIC", DB_C);
    await asApp(
      APP_B,
      DB_C,
      "CREATE TABLE open_table (x int); GRANT INSERT ON open_table TO PUBLIC;"
    );
    const writable = await enable(DB_C, RO_C, ENV_C);
    expect(writable.code).not.toBe(0);
    expect(writable.stderr).toMatch(/could write table public.open_table/);
    expect(
      (
        await superuser(
          `SELECT count(*) FROM pg_roles WHERE rolname = '${RO_C}'`
        )
      ).stdout
    ).toBe("0");
  });

  it("a role set from our verifier logs in over 127.0.0.1", async () => {
    // Plaintext only here and on stdin; Postgres gets the verifier alone.
    const password = "Fictional1Scratch2Password3abcde";
    const verifier = await scramSha256Verifier(password);
    const admin = await run(
      ["exec", "-i", CONTAINER, "bash", "-c", pgAssistantDbAdminPsql(DB_A)],
      pgEnableAssistantDbSql({
        database: DB_A,
        role: RO_A,
        environmentId: ENV_A,
        appRoles: [APP_A],
        adopt: true,
        passwordVerifier: verifier,
      })
    );
    expect(admin).toMatchObject({ code: 0 });
    // Stored as given, not hashed again.
    expect(
      (
        await superuser(
          `SELECT rolpassword FROM pg_authid WHERE rolname = '${RO_A}'`
        )
      ).stdout
    ).toBe(verifier);
    // The scratch container trusts 127.0.0.1, so the production check
    // command is pointed at its own non-loopback address, where pg_hba asks
    // for scram-sha-256 and the verifier is really checked.
    const address = (await shell("hostname -i")).stdout.split(/\s+/)[0] ?? "";
    expect(address).not.toMatch(/^(127\.|::1$|$)/);
    const production = pgAssistantDbCheckCommand(RO_A, DB_A, { tcp: true });
    expect(production).toContain("-h 127.0.0.1");
    const check = production.replace("-h 127.0.0.1", `-h ${address}`);
    const login = (pw: string) =>
      run(["exec", "-i", CONTAINER, "bash", "-c", check], `${pw}\n`);
    expect(await login(password)).toMatchObject({ code: 0, stdout: "1" });
    const wrong = await login("Wrong1Password2For3The4Login5abc");
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toMatch(/password authentication failed/);
    // The brief's literal form, over loopback (trusted here, so it proves
    // only that the command shape runs).
    expect(
      await run(
        [
          "exec",
          "-i",
          CONTAINER,
          "bash",
          "-c",
          `IFS= read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U ${RO_A} -d ${DB_A} -Atc "select 1"`,
        ],
        `${password}\n`
      )
    ).toMatchObject({ code: 0, stdout: "1" });
  });

  it("disable drops the role with its grants and default privileges; again is a no-op", async () => {
    expect(await disable(DB_A, RO_A, ENV_A)).toMatchObject({ code: 0 });
    expect(
      (
        await superuser(
          `SELECT count(*) FROM pg_roles WHERE rolname = '${RO_A}'`
        )
      ).stdout
    ).toBe("0");
    expect(
      (
        await superuser(
          `SELECT count(*) FROM pg_default_acl WHERE defaclacl::text LIKE '%${RO_A}%'`,
          DB_A
        )
      ).stdout
    ).toBe("0");
    expect((await asRo("SELECT 1;")).code).not.toBe(0);
    // The app's data is untouched.
    expect((await superuser("SELECT count(*) FROM members", DB_A)).stdout).toBe(
      "1"
    );
    expect(await disable(DB_A, RO_A, ENV_A)).toMatchObject({ code: 0 });
  });

  it("disable still drops the role after its database is gone", async () => {
    expect(await enable(DB_A, RO_A, ENV_A, [APP_A])).toMatchObject({ code: 0 });
    await superuser(`DROP DATABASE ${DB_A} WITH (FORCE)`);
    expect(await disable(DB_A, RO_A, ENV_A)).toMatchObject({ code: 0 });
    expect(
      (
        await superuser(
          `SELECT count(*) FROM pg_roles WHERE rolname = '${RO_A}'`
        )
      ).stdout
    ).toBe("0");
  });
});
