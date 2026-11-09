import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

// The backup lock against a real Postgres: the local opsdeck-postgres
// container, reached through its published port with the container's own
// superuser password, read from the container and never printed. Advisory
// locks need no schema, so BACKUP_LOCK_SCRATCH_DB can name any database
// (e.g. postgres); nothing is written to it.
//
//   BACKUP_LOCK_SCRATCH_DB=postgres env -u SECRETS_KEY bun --bun vitest run tests/instance-backup-lock-scratch.test.ts
const scratchDb = process.env.BACKUP_LOCK_SCRATCH_DB;
let url = "";
if (scratchDb) {
  const password = encodeURIComponent(
    execFileSync("podman", [
      "exec",
      "opsdeck-postgres",
      "printenv",
      "POSTGRES_PASSWORD",
    ])
      .toString()
      .trim()
  );
  url = `postgres://postgres:${password}@127.0.0.1:5432/${scratchDb}`;
  process.env.DATABASE_URL = url;
}

describe.skipIf(!scratchDb)("instance backup advisory lock", async () => {
  const { BACKUP_LOCK_KEY, pgBackupLock, runInstanceBackup } = await import(
    "@/lib/instance-backup/archive"
  );
  const root = await mkdtemp(join(tmpdir(), "backup-lock-"));
  // Another process: its own connection, outside the app's pool.
  const other = postgres(url, { max: 1 });
  afterAll(async () => {
    await other.end();
    await rm(root, { recursive: true, force: true });
  });

  const tryOther = async () =>
    (
      await other<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${BACKUP_LOCK_KEY}::bigint) as locked`
    )[0]?.locked;
  const unlockOther = () =>
    other`select pg_advisory_unlock(${BACKUP_LOCK_KEY}::bigint)`;

  it("is held across connections until released", async () => {
    const release = await pgBackupLock();
    expect(release).not.toBeNull();
    expect(await tryOther()).toBe(false);
    expect(await pgBackupLock()).toBeNull();
    await release?.();
    expect(await tryOther()).toBe(true);
    await unlockOther();
  });

  it("lets exactly one of two concurrent runs through", async () => {
    let started = 0;
    const rows: string[] = [];
    let gate: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const deps = {
      recorder: {
        start: async () => {
          rows.push("row");
          return `run-${rows.length}`;
        },
        finish: async () => {},
        recordFingerprint: async () => {},
        markInterrupted: async () => {},
      },
      destination: async () => null,
      garage: null,
      dumpDatabase: async (filePath: string) => {
        started += 1;
        await blocked;
        await writeFile(filePath, "PGDMP fake");
        return { sha256: "d".repeat(64), bytes: 10 };
      },
      localRoot: root,
      instance: "lock-it",
      version: "0.0.0",
      secretsKey: "k".repeat(44),
      now: () => new Date(),
      runSuffix: () => Math.random().toString(16).slice(2, 8),
      log: () => {},
    };
    const first = runInstanceBackup("schedule", deps);
    // Wait until the first run holds the lock and is dumping.
    for (let i = 0; started === 0 && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(started).toBe(1);
    const second = await runInstanceBackup("manual", deps);
    expect(second.status).toBe("alreadyRunning");
    expect(second.errorCode).toBe("backupAlreadyRunning");
    // A separate process (Task 6's CLI) is refused too.
    expect(await tryOther()).toBe(false);
    gate();
    expect((await first).status).toBe("succeeded");
    expect(rows).toHaveLength(1);
    // Released once the run finished.
    expect(await tryOther()).toBe(true);
    await unlockOther();
  });
});
