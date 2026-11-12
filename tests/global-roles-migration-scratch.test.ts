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
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The global-roles migration on real rows: a throwaway database made in the
// local opsdeck-postgres container (superuser password read from the
// container, never printed) and dropped afterwards. Every migration before
// 20261117000000_global_roles runs first, the fixtures go in with the old
// roles, then the real drizzle/ folder runs the global-roles migration.
//
//   GLOBAL_ROLES_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/global-roles-migration-scratch.test.ts
const enabled = process.env.GLOBAL_ROLES_SCRATCH === "1";
const MIGRATION = "20261117000000_global_roles";

// label → [users.role before, membership roles on p1, p2, …]
const USERS: [string, string, string[]][] = [
  ["admin with a qa membership", "admin", ["qa"]],
  ["infra", "infra", []],
  ["observer without memberships", "observer", []],
  ["observer with only viewer memberships", "observer", ["viewer"]],
  ["observer with an engineer membership", "observer", ["engineer"]],
  ["observer with a qa membership", "observer", ["qa"]],
  ["member with qa and engineer", "member", ["qa", "engineer"]],
  ["member with a viewer membership", "member", ["viewer"]],
  ["member with only engineer", "member", ["engineer", "engineer"]],
  ["member without memberships", "member", []],
  ["legacy maintainer with engineer", "maintainer", ["engineer"]],
];
const MEMBERSHIP_FIXTURES = USERS.reduce((n, [, , m]) => n + m.length, 0);

describe.skipIf(!enabled)("global roles migration on a real Postgres", () => {
  const dbName = `global_roles_${randomBytes(4).toString("hex")}`;
  const password = enabled
    ? encodeURIComponent(
        execFileSync("podman", [
          "exec",
          "opsdeck-postgres",
          "printenv",
          "POSTGRES_PASSWORD",
        ])
          .toString()
          .trim()
      )
    : "";
  const base = `postgres://postgres:${password}@127.0.0.1:5432`;
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  let sql: ReturnType<typeof postgres>;
  let before: string | undefined;

  const ids = new Map<string, string>(
    USERS.map(([label]) => [label, Bun.randomUUIDv7()])
  );
  const userId = (label: string) => {
    const id = ids.get(label);
    if (!id) throw new Error(`no fixture user ${label}`);
    return id;
  };
  const p1 = Bun.randomUUIDv7();
  const p2 = Bun.randomUUIDv7();
  const projectByKey: Record<string, string> = { p1, p2 };
  const projectOf = (key: string) => {
    const id = projectByKey[key];
    if (!id) throw new Error(`no fixture project ${key}`);
    return id;
  };

  const roleOf = async (label: string) => {
    const [row] = await sql`select role from users where id = ${userId(label)}`;
    return row?.role;
  };
  const inviteRole = async (token: string) => {
    const [row] =
      await sql`select role from invitations where token = ${token}`;
    return row?.role;
  };
  const count = async (table: string) => {
    const [row] = await sql`select count(*)::int as n from ${sql(table)}`;
    return row?.n;
  };
  const membershipRole = async (label: string, project: string) => {
    const [row] = await sql`
      select role from project_members
      where user_id = ${userId(label)} and project_id = ${projectOf(project)}`;
    return row?.role;
  };
  const columnExists = async (table: string, column: string) => {
    const rows = await sql`
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = ${table}
        and column_name = ${column}`;
    return rows.length === 1;
  };
  const typeExists = async (name: string) => {
    const rows = await sql`select 1 from pg_type where typname = ${name}`;
    return rows.length === 1;
  };

  beforeAll(async () => {
    await admin.unsafe(`create database ${dbName}`);
    sql = postgres(`${base}/${dbName}`, {
      max: 2,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    const db = drizzle({ client: sql });

    // The schema as the previous release left it.
    before = mkdtempSync(join(tmpdir(), "opsdeck-global-roles-"));
    for (const entry of readdirSync("drizzle")) {
      if (entry === MIGRATION) continue;
      cpSync(join("drizzle", entry), join(before, entry), { recursive: true });
    }
    await migrate(db, { migrationsFolder: before });

    await sql`insert into projects (id, name, key) values
      (${p1}, 'Project one', 'P1'), (${p2}, 'Project two', 'P2')`;
    for (const [label, role, memberships] of USERS) {
      const id = userId(label);
      await sql`insert into users (id, name, email, role) values
        (${id}, ${label}, ${`${id}@example.invalid`}, ${role})`;
      for (const [i, membership] of memberships.entries()) {
        await sql`insert into project_members (project_id, user_id, role)
          values (${projectOf(`p${i + 1}`)}, ${id}, ${membership})`;
      }
    }
    await sql`insert into invitations (email, name, token, expires_at, role) values
      ('m@example.invalid', 'M', 'invite-member', now() + interval '1 day', 'member'),
      ('a@example.invalid', 'A', 'invite-admin', now() + interval '1 day', 'admin')`;

    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    if (before) rmSync(before, { recursive: true, force: true });
    await sql?.end();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it.each([
    ["admin with a qa membership", "admin", ["qa"], "admin"],
    ["infra", "infra", [], "infra"],
    ["observer without memberships", "observer", [], "observer"],
    [
      "observer with only viewer memberships",
      "observer",
      ["viewer"],
      "observer",
    ],
    [
      "observer with an engineer membership",
      "observer",
      ["engineer"],
      "engineer",
    ],
    ["observer with a qa membership", "observer", ["qa"], "qa"],
    ["member with qa and engineer", "member", ["qa", "engineer"], "qa"],
    ["member with a viewer membership", "member", ["viewer"], "qa"],
    [
      "member with only engineer",
      "member",
      ["engineer", "engineer"],
      "engineer",
    ],
    ["member without memberships", "member", [], "qa"],
    ["legacy maintainer with engineer", "maintainer", ["engineer"], "engineer"],
  ])("%s → %s", async (label, from, memberships, expected) => {
    // The case table and the fixtures describe the same users.
    expect(USERS.find(([l]) => l === label)).toEqual([
      label,
      from,
      memberships,
    ]);
    expect(await roleOf(label)).toBe(expected);
  });

  it("maps pending member invitations to qa and keeps the others", async () => {
    expect(await inviteRole("invite-member")).toBe("qa");
    expect(await inviteRole("invite-admin")).toBe("admin");
  });

  it("keeps every membership row with its old role", async () => {
    expect(await count("project_members")).toBe(MEMBERSHIP_FIXTURES);
    expect(await membershipRole("member with only engineer", "p1")).toBe(
      "engineer"
    );
    expect(
      await membershipRole("observer with only viewer memberships", "p1")
    ).toBe("viewer");
  });

  it("defaults new users and invitations to qa", async () => {
    const id = Bun.randomUUIDv7();
    await sql`insert into users (id, name, email) values
      (${id}, 'New', ${`${id}@example.invalid`})`;
    const [user] = await sql`select role from users where id = ${id}`;
    expect(user?.role).toBe("qa");
    await sql`insert into invitations (email, name, token, expires_at) values
      ('n@example.invalid', 'N', 'invite-new', now() + interval '1 day')`;
    expect(await inviteRole("invite-new")).toBe("qa");
  });

  // A replay of the users mapping (a re-run by hand, a restore) must not touch
  // anyone already on a job role: an engineer added to a project after the
  // migration holds a role-less membership, which takes the default, and the
  // mapping would otherwise demote them to qa.
  it("replaying the users mapping changes nothing, even after a role-less membership", async () => {
    const usersUpdate = readFileSync(
      join("drizzle", MIGRATION, "migration.sql"),
      "utf8"
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.startsWith('UPDATE "users"'));
    if (!usersUpdate) throw new Error("no users UPDATE in the migration");
    const p3 = Bun.randomUUIDv7();
    await sql`insert into projects (id, name, key) values (${p3}, 'Project three', 'P3')`;
    await sql`insert into project_members (project_id, user_id) values (${p3}, ${userId("member with only engineer")})`;
    const roles = () => sql`select id, role from users order by id`;
    const before = await roles();
    expect(await roleOf("member with only engineer")).toBe("engineer");
    await sql.unsafe(usersUpdate);
    expect(await roles()).toEqual(before);
  });

  // The previous release still runs on this schema (update.sh rolls back to
  // it): its reads and writes of project_members.role must keep working.
  it("keeps the previous release's membership reads and writes working", async () => {
    expect(await columnExists("project_members", "role")).toBe(true);
    expect(await typeExists("project_role")).toBe(true);
    // This release's insert: no role, so the default applies.
    await sql`insert into project_members (project_id, user_id) values (${p2}, ${userId("infra")})`;
    // 'viewer', so a rollback can only lower rights.
    expect(await membershipRole("infra", "p2")).toBe("viewer");
    // The previous release's insert and select with an explicit role.
    await sql`insert into project_members (project_id, user_id, role) values (${p2}, ${userId("observer without memberships")}, 'engineer')`;
    const rows =
      await sql`select project_id, role from project_members where user_id = ${userId("observer without memberships")}`;
    expect(rows.map((r) => r.role)).toEqual(["engineer"]);
  });
});
