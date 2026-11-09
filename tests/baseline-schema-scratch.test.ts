import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adoptBaseline,
  baselineSchemaDiff,
  diffSchemaDumps,
  normaliseSchemaDump,
  postgresMigrationsTable,
} from "@/scripts/cli/migrate";

// The squashed baseline against the legacy migrations it replaces, on the
// local opsdeck-postgres container (postgres 18), reached through its
// published port with the container's own superuser password, read from the
// container and never printed. BASELINE_SCRATCH_DB names a prefix; the test
// (re)creates and drops <prefix>_legacy and <prefix>_baseline.
//
//   A (<prefix>_legacy):   every drizzle-legacy/*/migration.sql in order, via
//                          psql -v ON_ERROR_STOP=1, as production applied them.
//   B (<prefix>_baseline): `opsdeck migrate` (scripts/cli.ts).
//
//   BASELINE_SCRATCH_DB=baseline_scratch env -u SECRETS_KEY bun --bun vitest run tests/baseline-schema-scratch.test.ts
const prefix = process.env.BASELINE_SCRATCH_DB;
const CONTAINER = "opsdeck-postgres";

function psql(db: string, args: string[], input?: string) {
  return execFileSync(
    "podman",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
}

// pg_dump inside the container: the host has no PostgreSQL client.
async function podmanDump(url: string): Promise<string> {
  const db = decodeURIComponent(new URL(url).pathname.slice(1));
  return execFileSync(
    "podman",
    [
      "exec",
      CONTAINER,
      "pg_dump",
      "-U",
      "postgres",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--exclude-schema=drizzle",
      db,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
}

describe.skipIf(!prefix)("baseline on scratch", () => {
  const legacyDb = `${prefix}_legacy`;
  const baselineDb = `${prefix}_baseline`;
  let urlFor: (db: string) => string;

  function recreate(db: string) {
    psql("postgres", [
      "-c",
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
      "-c",
      `CREATE DATABASE "${db}"`,
    ]);
  }

  beforeAll(() => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    urlFor = (db) =>
      `postgres://postgres:${password}@127.0.0.1:5432/${encodeURIComponent(db)}`;

    recreate(legacyDb);
    const folders = readdirSync("drizzle-legacy").sort();
    expect(folders).toHaveLength(53);
    for (const folder of folders) {
      psql(
        legacyDb,
        [],
        readFileSync(`drizzle-legacy/${folder}/migration.sql`, "utf8")
      );
    }

    recreate(baselineDb);
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: urlFor(baselineDb),
      },
    });
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  afterAll(() => {
    if (!urlFor) return;
    for (const db of [legacyDb, baselineDb]) {
      psql("postgres", ["-c", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
    }
  });

  it("baseline reproduces the legacy schema", async () => {
    const a = await podmanDump(urlFor(legacyDb));
    const b = await podmanDump(urlFor(baselineDb));
    expect(normaliseSchemaDump(a).length).toBeGreaterThan(100);
    expect(diffSchemaDumps(a, b)).toEqual([]);

    const client = postgres(urlFor(baselineDb), { max: 1 });
    try {
      const rows = await client`select name from drizzle.__drizzle_migrations`;
      expect(rows.map((r) => r.name)).toEqual(["00000000000000_baseline"]);
      // The generic seed the legacy migrations left: the default labels.
      const labels = await client`select name, color from labels order by name`;
      const legacy = postgres(urlFor(legacyDb), { max: 1 });
      try {
        expect(labels).toEqual(
          await legacy`select name, color from labels order by name`
        );
      } finally {
        await legacy.end();
      }
    } finally {
      await client.end();
    }
  });

  it("adopt's own check accepts the legacy schema", async () => {
    const client = postgres(urlFor(legacyDb), { max: 1, onnotice: () => {} });
    try {
      const diff = await baselineSchemaDiff({
        client,
        url: urlFor(legacyDb),
        dump: podmanDump,
      });
      expect(diff).toEqual([]);
      // The throwaway comparison database is gone again.
      const left = await client`
        select datname from pg_database where datname like ${`${legacyDb}_adopt_%`}`;
      expect(left).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("adopt's own check reports a drifted schema", async () => {
    psql(legacyDb, ["-c", "DROP INDEX issues_updated_at_idx"]);
    const client = postgres(urlFor(legacyDb), { max: 1, onnotice: () => {} });
    try {
      const diff = await baselineSchemaDiff({
        client,
        url: urlFor(legacyDb),
        dump: podmanDump,
      });
      expect(diff).toEqual([
        expect.stringMatching(/^- CREATE INDEX issues_updated_at_idx /),
      ]);
    } finally {
      await client.end();
      psql(legacyDb, [
        "-c",
        "CREATE INDEX issues_updated_at_idx ON issues (updated_at DESC)",
      ]);
    }
  });

  it("an adopted database runs only the migrations after the baseline", async () => {
    // Production's state: the migrator's table exists but is empty. The
    // oldest, name-less shape is used so the upgrade path is covered too.
    psql(legacyDb, [
      "-c",
      "CREATE SCHEMA drizzle",
      "-c",
      "CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    ]);
    const folder = mkdtempSync(join(tmpdir(), "opsdeck-migrations-"));
    cpSync("drizzle", folder, { recursive: true });
    mkdirSync(join(folder, "20990101000000_probe"));
    writeFileSync(
      join(folder, "20990101000000_probe", "migration.sql"),
      "SET LOCAL lock_timeout = '5s';--> statement-breakpoint\nCREATE TABLE adopt_probe (id int);"
    );

    const client = postgres(urlFor(legacyDb), { max: 1, onnotice: () => {} });
    try {
      const code = await adoptBaseline({
        table: postgresMigrationsTable(client),
        schemaDiff: () =>
          baselineSchemaDiff({
            client,
            url: urlFor(legacyDb),
            dump: podmanDump,
          }),
        out: () => {},
      });
      expect(code).toBe(0);

      // Re-running the baseline would fail (its types already exist).
      await migrate(drizzle({ client }), { migrationsFolder: folder });
      const rows = await client`
        select name from drizzle.__drizzle_migrations order by id`;
      expect(rows.map((r) => r.name)).toEqual([
        "00000000000000_baseline",
        "20990101000000_probe",
      ]);
      const [probe] = await client`select to_regclass('adopt_probe') as t`;
      expect(probe?.t).toBe("adopt_probe");
    } finally {
      await client.end();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
