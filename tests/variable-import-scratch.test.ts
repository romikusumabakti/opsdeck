import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// importVariables (lib/variables/repository) against a real Menara database:
// the local scratch copy named by VARIMPORT_SCRATCH_DB (a migrated database
// in the menara-postgres container), reached through its published port
// with the container's own superuser password, read from the container and
// never printed. Every fixture is named vi-it/VIIT and removed.
//
//   VARIMPORT_SCRATCH_DB=varimport_scratch bun --bun vitest run tests/variable-import-scratch.test.ts
const scratchDb = process.env.VARIMPORT_SCRATCH_DB;
if (scratchDb) {
  const password = encodeURIComponent(
    execFileSync("podman", [
      "exec",
      "menara-postgres",
      "printenv",
      "POSTGRES_PASSWORD",
    ])
      .toString()
      .trim()
  );
  process.env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:5432/${scratchDb}`;
  process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
}

describe.skipIf(!scratchDb)("importVariables on scratch", async () => {
  const { and, eq } = await import("drizzle-orm");
  const { db, pgClient } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const { importVariables } = await import("@/lib/variables/repository");

  const ids = { project: "", env: "" };

  async function cleanup() {
    await db.delete(s.projects).where(eq(s.projects.key, "VIIT"));
  }

  beforeAll(async () => {
    await cleanup();
    const [project] = await db
      .insert(s.projects)
      .values({ key: "VIIT", name: "Var Import IT" })
      .returning({ id: s.projects.id });
    if (!project) throw new Error("no project");
    ids.project = project.id;
    const [env] = await db
      .insert(s.environments)
      .values({ projectId: ids.project, name: "vi-it", slug: "vi-it" })
      .returning({ id: s.environments.id });
    if (!env) throw new Error("no environment");
    ids.env = env.id;
  });

  afterAll(async () => {
    await cleanup();
    await pgClient().end();
  });

  beforeEach(async () => {
    await db
      .delete(s.environmentVariables)
      .where(eq(s.environmentVariables.environmentId, ids.env));
    await db.insert(s.environmentVariables).values([
      {
        environmentId: ids.env,
        name: "KEPT",
        kind: "plain",
        value: "old",
        escrow: false,
      },
      {
        environmentId: ids.env,
        name: "LOCKED",
        kind: "secret",
        value: "ciphertext-old",
        escrow: true,
      },
    ]);
  });

  const write = (name: string, value: string) => ({
    environmentId: ids.env,
    name,
    kind: "plain" as const,
    value,
    escrow: false,
    updatedBy: null,
  });

  async function values() {
    const rows = await db
      .select({
        name: s.environmentVariables.name,
        value: s.environmentVariables.value,
        kind: s.environmentVariables.kind,
        escrow: s.environmentVariables.escrow,
      })
      .from(s.environmentVariables)
      .where(eq(s.environmentVariables.environmentId, ids.env))
      .orderBy(s.environmentVariables.name);
    return rows;
  }

  it("inserts and replaces in one statement, telling overwritten rows apart", async () => {
    const result = await db.transaction((tx) =>
      importVariables(tx, [
        write("KEPT", "new"),
        { ...write("FRESH", "ciphertext-x"), kind: "secret", escrow: true },
      ])
    );
    expect([...result].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
      { name: "FRESH", overwritten: false },
      { name: "KEPT", overwritten: true },
    ]);
    expect(await values()).toEqual([
      { name: "FRESH", value: "ciphertext-x", kind: "secret", escrow: true },
      { name: "KEPT", value: "new", kind: "plain", escrow: false },
      { name: "LOCKED", value: "ciphertext-old", kind: "secret", escrow: true },
    ]);
  });

  it("never replaces an escrowed row, and a rollback keeps the others too", async () => {
    await expect(
      db.transaction(async (tx) => {
        const result = await importVariables(tx, [
          write("KEPT", "new"),
          write("LOCKED", "plain-now"),
          write("FRESH", "x"),
        ]);
        expect(result.map((r) => r.name).sort()).toEqual(["FRESH", "KEPT"]);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(await values()).toEqual([
      { name: "KEPT", value: "old", kind: "plain", escrow: false },
      { name: "LOCKED", value: "ciphertext-old", kind: "secret", escrow: true },
    ]);
    const locked = await db
      .select({ value: s.environmentVariables.value })
      .from(s.environmentVariables)
      .where(
        and(
          eq(s.environmentVariables.environmentId, ids.env),
          eq(s.environmentVariables.name, "LOCKED")
        )
      );
    expect(locked).toEqual([{ value: "ciphertext-old" }]);
  });
});
