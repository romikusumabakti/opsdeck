import { beforeEach, describe, expect, it, vi } from "vitest";

// startProvisioningRun and the boot sweep against a fake transaction that
// records writes (no Postgres here).
const fake = vi.hoisted(() => ({
  active: null as null | { id: string; runAt: Date },
  updates: [] as { table: string; set: Record<string, unknown> }[],
  inserts: 0,
  swept: [] as { environmentId: string }[],
  tearingDown: false,
}));

// The teardown guard's SQL is covered on scratch; here it answers `fake`.
vi.mock("@/lib/teardown/guard", () => ({
  holdEnvironmentShared: async () => {},
  holdEnvironmentExclusive: async () => {},
  teardownBlocks: async () => fake.tearingDown,
}));
vi.mock("@/lib/db", () => {
  const tableName = (t: unknown) =>
    (t as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "?";
  const tx = {
    execute: async () => {},
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (fake.active ? [fake.active] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        fake.updates.push({ table: tableName(table), set });
        const done = Promise.resolve([...fake.swept]);
        return {
          where: () =>
            Object.assign(done, { returning: async () => [...fake.swept] }),
        };
      },
    }),
    insert: () => ({
      values: () => {
        fake.inserts++;
        return { returning: async () => [{ id: "new-run" }] };
      },
    }),
  };
  return {
    db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
  };
});

const { startProvisioningRun, failStaleProvisionRuns } = await import(
  "@/lib/provisioning/repository"
);

beforeEach(() => {
  fake.active = null;
  fake.updates = [];
  fake.inserts = 0;
  fake.swept = [];
  fake.tearingDown = false;
});

const ago = (ms: number) => new Date(Date.now() - ms);

describe("startProvisioningRun", () => {
  it("opens no run while the environment is being deleted", async () => {
    fake.tearingDown = true;
    await expect(startProvisioningRun("env", "u")).resolves.toEqual({
      tearingDown: true,
    });
    expect(fake.inserts).toBe(0);
    expect(fake.updates).toEqual([]);
  });

  it("conflicts with a recent started run", async () => {
    fake.active = { id: "r1", runAt: ago(5 * 60_000) };
    await expect(startProvisioningRun("env", "u")).resolves.toEqual({
      conflict: true,
    });
    expect(fake.inserts).toBe(0);
  });

  it("fails a started run older than an hour and starts a new one", async () => {
    fake.active = { id: "r1", runAt: ago(61 * 60_000) };
    await expect(startProvisioningRun("env", "u")).resolves.toEqual({
      runId: "new-run",
    });
    expect(fake.updates[0]?.set).toMatchObject({ status: "failed" });
    expect(fake.updates[1]?.set).toMatchObject({ status: "failed" });
    expect(fake.inserts).toBe(1);
  });
});

describe("failStaleProvisionRuns", () => {
  it("fails started provision runs and their running steps", async () => {
    fake.swept = [{ environmentId: "e1" }, { environmentId: "e1" }];
    await expect(failStaleProvisionRuns()).resolves.toBe(2);
    expect(fake.updates).toHaveLength(2);
    expect(fake.updates[0]?.set).toMatchObject({
      status: "failed",
      errorMessage: "Worker restarted during provisioning; retry",
    });
    expect(fake.updates[1]?.set).toMatchObject({ status: "failed" });
  });

  it("touches no steps when nothing was started", async () => {
    await expect(failStaleProvisionRuns()).resolves.toBe(0);
    expect(fake.updates).toHaveLength(1);
  });
});
