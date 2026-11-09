import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

// The key-operation locks against a real Postgres: the local opsdeck-postgres
// container, reached through its published port with the container's own
// superuser password, read from the container and never printed. Advisory
// locks need no schema, so KEY_LOCK_SCRATCH_DB can name any database (e.g.
// postgres); nothing is written to it.
//
//   KEY_LOCK_SCRATCH_DB=postgres env -u SECRETS_KEY bun --bun vitest run tests/ssh-key-locks-scratch.test.ts
const scratchDb = process.env.KEY_LOCK_SCRATCH_DB;
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

describe.skipIf(!scratchDb)(
  "key-operation locks on real Postgres",
  async () => {
    const { SERVER_KEY_LOCK_CLASS, serverKeyLock } = await import(
      "@/lib/ssh-keys"
    );
    const { pgClient } = await import("@/lib/db");
    // Another process: its own connection, outside the app's pool.
    const other = postgres(url, { max: 1 });
    afterAll(async () => {
      await other.end();
      await pgClient().end();
    });

    const backendsHolding = async (serverId: string) =>
      other<{ pid: number }[]>`
      select pid from pg_locks
      where locktype = 'advisory' and granted
        and classid = ${SERVER_KEY_LOCK_CLASS}::oid
        and objid = hashtext(${serverId}::text)::oid`;

    it("ten concurrent key operations, each querying the pool inside its lock, all finish", async () => {
      const started = Date.now();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const release = await serverKeyLock(`scratch-concurrent-${i}`);
          if (!release) return "refused";
          try {
            // What a holder does: queries through the app's pool.
            for (let q = 0; q < 3; q++) await pgClient()`select 1`;
            await new Promise((r) => setTimeout(r, 200));
          } finally {
            await release();
          }
          return "done";
        })
      );
      expect(outcomes).toEqual(Array(10).fill("done"));
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it("the pool keeps answering while every lock session is held", async () => {
      const held = await Promise.all(
        [0, 1, 2, 3].map((i) => serverKeyLock(`scratch-held-${i}`))
      );
      expect(held.every((r) => r !== null)).toBe(true);
      const rows = await Promise.all(
        Array.from(
          { length: 12 },
          () => pgClient()<{ one: number }[]>`select 1 as one`
        )
      );
      expect(rows.map((r) => r[0]?.one)).toEqual(Array(12).fill(1));
      // A fifth lock waits a bounded time, then is refused.
      const before = Date.now();
      expect(await serverKeyLock("scratch-held-4")).toBeNull();
      expect(Date.now() - before).toBeGreaterThanOrEqual(4_900);
      for (const r of held) await r?.();
      expect(await backendsHolding("scratch-held-0")).toEqual([]);
    }, 15_000);

    it("a lock whose session was killed releases cleanly, and is free again", async () => {
      const id = "scratch-killed";
      const release = await serverKeyLock(id);
      expect(release).not.toBeNull();
      const [holder] = await backendsHolding(id);
      expect(holder).toBeDefined();
      await other`select pg_terminate_backend(${holder?.pid ?? 0}::int)`;
      // Let the client notice the session is gone.
      await new Promise((r) => setTimeout(r, 300));
      await expect(release?.()).resolves.toBeUndefined();
      const again = await serverKeyLock(id);
      expect(again).not.toBeNull();
      await again?.();
    });

    it("a release racing the session's death settles without a stray error", async () => {
      const id = "scratch-racing";
      const release = await serverKeyLock(id);
      const [holder] = await backendsHolding(id);
      await other`select pg_terminate_backend(${holder?.pid ?? 0}::int)`;
      // No wait: the unlock may go out before the client sees the close.
      await release?.().catch(() => {});
      const again = await serverKeyLock(id);
      expect(again).not.toBeNull();
      await again?.();
    });
  }
);
