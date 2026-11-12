import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_ACCOUNTS,
  runSeed,
  type SeedOptions,
  SeedRefusedError,
  seedDemo,
} from "@/scripts/cli/seed";

// The seed against a real Postgres: a throwaway database made in the local
// opsdeck-postgres container (superuser password read from the container,
// never printed) and dropped afterwards.
//
//   SEED_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/cli-seed.test.ts
const enabled = process.env.SEED_SCRATCH === "1";

describe("opsdeck seed demo arguments", () => {
  it("rejects an unknown subcommand or flag", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(await runSeed(["nope"])).toBe(1);
      expect(await runSeed(["demo", "--bogus"])).toBe(1);
    } finally {
      console.error = original;
    }
  });
});

describe.skipIf(!enabled)("opsdeck seed demo on a real Postgres", () => {
  const dbName = `seed_${randomBytes(4).toString("hex")}`;
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
  let db: ReturnType<typeof drizzle>;

  const lines: string[] = [];
  const options = (over: Partial<SeedOptions> = {}): SeedOptions => ({
    printPasswords: false,
    force: false,
    nodeEnv: "test",
    hashPassword: async (p) => `hash:${p}`,
    encryptSecret: (p) => `enc:v1:${p.length}`,
    out: (l) => lines.push(l),
    ...over,
  });

  const counts = async () => {
    const [row] = await sql`
      select
        (select count(*) from projects)::int as projects,
        (select count(*) from environments)::int as environments,
        (select count(*) from servers)::int as servers,
        (select count(*) from issues)::int as issues,
        (select count(*) from users)::int as users,
        (select count(*) from accounts)::int as accounts,
        (select count(*) from project_members)::int as members`;
    return row as Record<string, number>;
  };

  beforeAll(async () => {
    await admin.unsafe(`create database ${dbName}`);
    sql = postgres(`${base}/${dbName}`, {
      max: 2,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    db = drizzle({ client: sql });
    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it("seed is idempotent", async () => {
    lines.length = 0;
    await seedDemo(db, options({ printPasswords: true }));
    const first = await counts();
    expect(first).toMatchObject({
      projects: 2,
      environments: 4,
      servers: 2,
      users: 5,
      accounts: 5,
      members: 4,
    });
    expect(first.issues).toBeGreaterThan(0);
    expect(lines).toHaveLength(5);
    expect(
      lines.every((l) => l.startsWith("created") && l.includes("password: "))
    ).toBe(true);

    lines.length = 0;
    await seedDemo(db, options({ printPasswords: true }));
    expect(await counts()).toEqual(first);
    expect(lines).toHaveLength(5);
    expect(
      lines.every((l) => l.startsWith("exists") && !l.includes("password"))
    ).toBe(true);
  });

  it("never prints passwords without --print-passwords", async () => {
    await sql`delete from users where email = 'demo-qa@example.invalid'`;
    lines.length = 0;
    await seedDemo(db, options());
    expect(lines.filter((l) => l.startsWith("created"))).toEqual([
      "created demo-qa@example.invalid (qa)",
    ]);
  });

  it("prints passwords only once the transaction commits", async () => {
    await sql`delete from users where email in ('demo-engineer@example.invalid', 'demo-qa@example.invalid')`;
    lines.length = 0;
    let hashed = 0;
    await expect(
      seedDemo(
        db,
        options({
          printPasswords: true,
          hashPassword: async (p) => {
            hashed += 1;
            if (hashed === 2) throw new Error("hash failed");
            return `hash:${p}`;
          },
        })
      )
    ).rejects.toThrow("hash failed");
    // The first account was created inside the rolled-back transaction: its
    // password was never printed, and the account does not exist.
    expect(lines).toEqual([]);
    const [{ n }] =
      (await sql`select count(*)::int as n from users where email in ('demo-engineer@example.invalid', 'demo-qa@example.invalid')`) as unknown as [
        { n: number },
      ];
    expect(n).toBe(0);
    await seedDemo(db, options());
  });

  it("keeps the roles and memberships exactly as specified", async () => {
    const roles = await sql`select email, role from users order by email`;
    expect(Object.fromEntries(roles.map((r) => [r.email, r.role]))).toEqual({
      "demo-admin@example.invalid": "admin",
      "demo-infra@example.invalid": "infra",
      "demo-observer@example.invalid": "observer",
      "demo-engineer@example.invalid": "engineer",
      "demo-qa@example.invalid": "qa",
    });
    const members = await sql`
      select u.email, p.key from project_members m
      join users u on u.id = m.user_id join projects p on p.id = m.project_id`;
    expect(members).toHaveLength(4);
    for (const name of ["demo-engineer", "demo-qa"]) {
      const mine = members.filter((m) => m.email === `${name}@example.invalid`);
      expect(mine.map((m) => m.key).sort()).toEqual(["DEMO", "DEMOPORTAL"]);
    }
    expect(DEMO_ACCOUNTS).toHaveLength(5);
    const credential = await sql`select provider_id from accounts`;
    expect(credential.every((a) => a.provider_id === "credential")).toBe(true);
  });

  it("creates only unreachable placeholder servers, and mixed issue statuses", async () => {
    const rows = await sql`select host, placement from servers`;
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.host.endsWith(".invalid") && r.placement === "open")
    ).toBe(true);
    const statuses = await sql`select distinct status from issues`;
    expect(statuses.length).toBeGreaterThan(1);
  });

  it("refuses on a stable channel in production, unless forced", async () => {
    await expect(
      seedDemo(db, options({ nodeEnv: "production" }))
    ).rejects.toBeInstanceOf(SeedRefusedError);
    await seedDemo(db, options({ nodeEnv: "production", force: true }));

    await sql`update instance_settings set update_channel = 'beta' where id = 1`;
    await seedDemo(db, options({ nodeEnv: "production" }));
    await sql`update instance_settings set update_channel = 'stable' where id = 1`;
  });
});
