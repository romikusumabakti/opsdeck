import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
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

// The squashed baseline against production's schema, on the local
// opsdeck-postgres container (postgres 18), reached through its published port
// with the container's own superuser password, read from the container and
// never printed. BASELINE_SCRATCH_DB names a prefix; the test (re)creates and
// drops <prefix>_prod and <prefix>_baseline.
//
//   reference:             tests/fixtures/prod-schema-20261109.sql, production's
//                          pg_dump --schema-only --no-owner --no-privileges of
//                          2026-11-09 with the drizzle schema left out.
//   A (<prefix>_prod):     that fixture loaded with psql: a stand-in for
//                          production to adopt.
//   B (<prefix>_baseline): `opsdeck migrate` (scripts/cli.ts).
//
// The legacy migrations (drizzle-legacy/) are not replayed: production evolved
// partly outside them, so their replay is known to drift from production
// (constraint names, index NULLS order, column order, a stray foreign key).
//
//   BASELINE_SCRATCH_DB=baseline_scratch env -u SECRETS_KEY bun --bun vitest run tests/baseline-schema-scratch.test.ts
const prefix = process.env.BASELINE_SCRATCH_DB;
const CONTAINER = "opsdeck-postgres";
const PROD_SCHEMA = "tests/fixtures/prod-schema-20261109.sql";

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
  const prodDb = `${prefix}_prod`;
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

    recreate(prodDb);
    psql(prodDb, [], readFileSync(PROD_SCHEMA, "utf8"));

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
    for (const db of [prodDb, baselineDb]) {
      psql("postgres", ["-c", `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
    }
  });

  it("baseline reproduces the production schema", async () => {
    const prod = readFileSync(PROD_SCHEMA, "utf8");
    const b = await podmanDump(urlFor(baselineDb));
    expect(normaliseSchemaDump(prod).length).toBeGreaterThan(100);
    expect(diffSchemaDumps(prod, b)).toEqual([]);

    const client = postgres(urlFor(baselineDb), { max: 1 });
    try {
      const rows = await client`select name from drizzle.__drizzle_migrations`;
      expect(rows.map((r) => r.name)).toEqual(["00000000000000_baseline"]);
      // The one generic seed: the default labels of 20260711050000_labels.
      const labels = await client`select name, color from labels order by name`;
      expect(labels.map((l) => `${l.name} ${l.color}`)).toEqual([
        "blocked #f97316",
        "bug #ef4444",
        "duplicate #94a3b8",
        "enhancement #22c55e",
        "feature #3b82f6",
        "question #a855f7",
      ]);
    } finally {
      await client.end();
    }
  });

  it("adopt's own check accepts the production schema", async () => {
    const client = postgres(urlFor(prodDb), { max: 1, onnotice: () => {} });
    try {
      const diff = await baselineSchemaDiff({
        client,
        url: urlFor(prodDb),
        dump: podmanDump,
      });
      expect(diff).toEqual([]);
      // The throwaway comparison database is gone again.
      const left = await client`
        select datname from pg_database where datname like ${`${prodDb}_adopt_%`}`;
      expect(left).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("adopt's own check reports a drifted schema", async () => {
    psql(prodDb, ["-c", "DROP INDEX issues_updated_at_idx"]);
    const client = postgres(urlFor(prodDb), { max: 1, onnotice: () => {} });
    try {
      const diff = await baselineSchemaDiff({
        client,
        url: urlFor(prodDb),
        dump: podmanDump,
      });
      expect(diff).toEqual([
        expect.stringMatching(/^- CREATE INDEX issues_updated_at_idx /),
      ]);
    } finally {
      await client.end();
      psql(prodDb, [
        "-c",
        "CREATE INDEX issues_updated_at_idx ON issues (updated_at DESC)",
      ]);
    }
  });

  it("an adopted database runs only the migrations after the baseline", async () => {
    // Production's state: the migrator's table exists but is empty
    // (production's has the current columns; the oldest, name-less shape is
    // used here so the upgrade path is covered too).
    psql(prodDb, [
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

    const client = postgres(urlFor(prodDb), { max: 1, onnotice: () => {} });
    try {
      const code = await adoptBaseline({
        table: postgresMigrationsTable(client),
        schemaDiff: () =>
          baselineSchemaDiff({
            client,
            url: urlFor(prodDb),
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
