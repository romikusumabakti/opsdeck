import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { generateKeyBetween } from "fractional-indexing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The project-groups migration and its client backfill on real rows: two
// throwaway databases made in the local menara-postgres container (superuser
// password read from the container, never printed) and dropped afterwards.
// Every migration before 20261127000000_project_groups runs first, the
// fixtures go in, then the real drizzle/ folder runs the migration.
//
//   PROJECT_GROUPS_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/project-groups-migration-scratch.test.ts
const enabled = process.env.PROJECT_GROUPS_SCRATCH === "1";
const MIGRATION = "20261127000000_project_groups";

const suffix = randomBytes(4).toString("hex");
const dbName = `project_groups_${suffix}`;
const emptyDbName = `project_groups_empty_${suffix}`;
const password = enabled
  ? encodeURIComponent(
      execFileSync("podman", [
        "exec",
        "menara-postgres",
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    )
  : "";
const base = `postgres://postgres:${password}@127.0.0.1:5432`;

// Fictional client labels; "key" is the project key, "client" the legacy value.
const FIXTURES: { key: string; client: string | null }[] = [
  { key: "A1", client: " Acme " },
  { key: "A2", client: "acme" },
  { key: "A3", client: "ACME" },
  { key: "A4", client: "acme" },
  // A tie (one each): the byte-order first spelling wins ("Beta" < "beta").
  { key: "B1", client: "beta" },
  { key: "B2", client: "Beta" },
  { key: "C1", client: "Cobalt  Works" },
  { key: "N1", client: null },
  { key: "N2", client: "" },
  { key: "N3", client: "   " },
];
// Enough extra groups to run past the one-letter rank range (62 groups).
const MANY = Array.from(
  { length: 64 },
  (_, i) => `Zeta ${String(i).padStart(2, "0")}`
);

describe.skipIf(!enabled)("project groups migration on a real Postgres", () => {
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  let sql: ReturnType<typeof postgres>;
  let before: string | undefined;

  const groups = () =>
    sql`select id, name, rank from project_groups order by rank`;
  const groupOf = async (key: string) => {
    const [row] = await sql`select g.name from projects p
        left join project_groups g on g.id = p.group_id where p.key = ${key}`;
    return row?.name ?? null;
  };

  beforeAll(async () => {
    await admin.unsafe(`create database ${dbName}`);
    await admin.unsafe(`create database ${emptyDbName}`);
    sql = postgres(`${base}/${dbName}`, {
      max: 2,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    const db = drizzle({ client: sql });

    before = mkdtempSync(join(tmpdir(), "menara-project-groups-"));
    for (const entry of readdirSync("drizzle")) {
      if (entry === MIGRATION) continue;
      cpSync(join("drizzle", entry), join(before, entry), {
        recursive: true,
      });
    }
    await migrate(db, { migrationsFolder: before });

    for (const f of FIXTURES) {
      await sql`insert into projects (name, key, client)
          values (${`Project ${f.key}`}, ${f.key}, ${f.client})`;
    }
    for (const [i, name] of MANY.entries()) {
      await sql`insert into projects (name, key, client)
          values (${`Many ${i}`}, ${`M${i}`}, ${name})`;
    }

    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    if (before) rmSync(before, { recursive: true, force: true });
    await sql?.end();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`drop database if exists ${emptyDbName} with (force)`);
    await admin.end();
  });

  it("merges case and space variants into one group named by the most frequent spelling", async () => {
    const rows = await sql`select name from project_groups
        where lower(trim(name)) = 'acme'`;
    expect(rows.map((r) => r.name)).toEqual(["acme"]);
    for (const key of ["A1", "A2", "A3", "A4"]) {
      expect(await groupOf(key)).toBe("acme");
    }
  });

  it("breaks a tie alphabetically in byte order", async () => {
    expect(await groupOf("B1")).toBe("Beta");
    expect(await groupOf("B2")).toBe("Beta");
  });

  it("keeps inner spacing and leaves null, empty and blank clients ungrouped", async () => {
    expect(await groupOf("C1")).toBe("Cobalt  Works");
    for (const key of ["N1", "N2", "N3"]) {
      expect(await groupOf(key)).toBeNull();
    }
  });

  it("creates exactly one group per distinct key", async () => {
    expect(await groups()).toHaveLength(3 + MANY.length);
  });

  it("ranks groups alphabetically as generateKeyBetween would append them", async () => {
    const byName = await sql`select name, rank from project_groups
        order by lower(name) collate "C", name collate "C"`;
    let prev: string | null = null;
    for (const row of byName) {
      prev = generateKeyBetween(prev, null);
      expect(row.rank).toBe(prev);
    }
  });

  it("leaves projects.client untouched", async () => {
    const [row] = await sql`select client from projects where key = 'A1'`;
    expect(row?.client).toBe(" Acme ");
  });

  it("is idempotent: re-running the backfill inserts and links nothing", async () => {
    const statements = readFileSync(
      join("drizzle", MIGRATION, "migration.sql"),
      "utf8"
    ).split("--> statement-breakpoint");
    const backfill = statements.filter((s) =>
      /^\s*(--[^\n]*\n)*\s*(INSERT INTO "project_groups"|UPDATE "projects")/.test(
        s
      )
    );
    expect(backfill).toHaveLength(2);
    const snapshot = async () =>
      JSON.stringify([
        await sql`select id, name, rank from project_groups order by id`,
        await sql`select key, group_id from projects order by key`,
      ]);
    const first = await snapshot();
    for (const statement of backfill) await sql.unsafe(statement);
    expect(await snapshot()).toBe(first);
  });

  it("rejects a duplicate name differing only in case or spacing", async () => {
    await expect(
      sql`insert into project_groups (name, rank) values (' ACME', 'zz')`
    ).rejects.toThrow(/project_groups_name_unique_idx/);
  });

  it("ungroups projects when their group is deleted", async () => {
    await sql`delete from project_groups where name = 'Cobalt  Works'`;
    expect(await groupOf("C1")).toBeNull();
  });

  it("is a no-op on an empty database", async () => {
    const empty = postgres(`${base}/${emptyDbName}`, {
      max: 1,
      onnotice: () => {},
    });
    try {
      await migrate(drizzle({ client: empty }), {
        migrationsFolder: "drizzle",
      });
      const rows =
        await empty`select count(*)::int as count from project_groups`;
      const count = rows[0]?.count;
      expect(count).toBe(0);
    } finally {
      await empty.end();
    }
  });
});
