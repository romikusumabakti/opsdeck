import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { pgRestoreDatabase, type Spawner } from "@/lib/instance-backup/restore";

// The restore's database swap against a real Postgres: the local
// opsdeck-postgres container through its published port, with the
// container's superuser password read from the container and never printed.
// The host has no pg_restore, so the spawner runs the exact argv inside the
// container (same libpq env). It creates and drops rt_* databases only.
//
//   RESTORE_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/cli-restore-scratch.test.ts
const enabled = process.env.RESTORE_SCRATCH === "1";
const CONTAINER = "opsdeck-postgres";

function password(): string {
  return execFileSync("podman", [
    "exec",
    CONTAINER,
    "printenv",
    "POSTGRES_PASSWORD",
  ])
    .toString()
    .trim();
}

const inContainer: Spawner = async (cmd, env) => {
  const dump = cmd.at(-1) ?? "";
  execFileSync("podman", ["cp", dump, `${CONTAINER}:/tmp/rt-restore.dump`]);
  const envArgs = Object.entries(env)
    .filter(([k]) => k.startsWith("PG"))
    .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  try {
    execFileSync(
      "podman",
      [
        "exec",
        ...envArgs,
        CONTAINER,
        ...cmd.slice(0, -1),
        "/tmp/rt-restore.dump",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer };
    return { exitCode: e.status ?? 1, stderr: e.stderr?.toString() ?? "" };
  }
};

describe.skipIf(!enabled)("pgRestoreDatabase on a real Postgres", async () => {
  const base = `postgres://postgres:${encodeURIComponent(enabled ? password() : "")}@127.0.0.1:5432`;
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  const dir = await mkdtemp(join(tmpdir(), "restore-scratch-"));
  const dbs = ["rt_live", "rt_src", "rt_live_restore", "rt_live_pre_restore"];
  const dropAll = async () => {
    for (const d of dbs)
      await admin.unsafe(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  };
  afterAll(async () => {
    await dropAll();
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces the schema exactly, drizzle journal included, and swaps atomically", async () => {
    await dropAll();
    await admin.unsafe("CREATE DATABASE rt_live");
    await admin.unsafe("CREATE DATABASE rt_src");
    // The live database is "newer": one more migration and a table the
    // backup's version does not have.
    const live = postgres(`${base}/rt_live`, { max: 1, onnotice: () => {} });
    await live.unsafe(`
      create schema drizzle;
      create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into drizzle.__drizzle_migrations (hash) values ('m1'), ('m2');
      create table public.items (id int primary key, name text);
      insert into public.items values (1, 'live');
      create table public.newer_only (id int);`);
    const src = postgres(`${base}/rt_src`, { max: 1, onnotice: () => {} });
    await src.unsafe(`
      create schema drizzle;
      create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
      insert into drizzle.__drizzle_migrations (hash) values ('m1');
      create table public.items (id int primary key, name text);
      insert into public.items values (1, 'backup'), (2, 'backup');`);
    await src.end();
    const dumpPath = join(dir, "database.dump");
    execFileSync("sh", [
      "-c",
      `podman exec ${CONTAINER} pg_dump -U postgres --format=custom rt_src > '${dumpPath}'`,
    ]);

    const database = pgRestoreDatabase(`${base}/rt_live`, {
      spawn: inContainer,
    });
    await database.prepare(dumpPath);
    // Still the live data until the swap; `live` stays connected meanwhile.
    expect((await live`select name from items`).map((r) => r.name)).toEqual([
      "live",
    ]);
    await database.swap();
    await database.dropPrevious();
    await database.close();
    await live.end().catch(() => {});

    const after = postgres(`${base}/rt_live`, { max: 1, onnotice: () => {} });
    expect(
      (await after`select name from items order by id`).map((r) => r.name)
    ).toEqual(["backup", "backup"]);
    expect(await after`select to_regclass('public.newer_only') as t`).toEqual([
      { t: null },
    ]);
    expect(
      (await after`select hash from drizzle.__drizzle_migrations`).map(
        (r) => r.hash
      )
    ).toEqual(["m1"]);
    await after.end();
    const left =
      await admin`select datname from pg_database where datname like 'rt_live%' order by 1`;
    expect(left.map((r) => r.datname)).toEqual(["rt_live"]);
  });

  it("a failing pg_restore leaves the live database untouched", async () => {
    await dropAll();
    await admin.unsafe("CREATE DATABASE rt_live");
    const live = postgres(`${base}/rt_live`, { max: 1, onnotice: () => {} });
    await live.unsafe(
      "create table items (id int); insert into items values (7);"
    );
    const junk = join(dir, "junk.dump");
    await Bun.write(junk, "not a dump");
    const database = pgRestoreDatabase(`${base}/rt_live`, {
      spawn: inContainer,
    });
    await expect(database.prepare(junk)).rejects.toThrow(/pg_restore exited/);
    await database.close();
    expect(await live`select id from items`).toEqual([{ id: 7 }]);
    await live.end();
  });
});
