import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
const update = vi.fn();
vi.mock("@/lib/db", () => ({ db: { transaction, update } }));

const {
  claimDeployment,
  deriveTagState,
  failStaleRunningDeployments,
  heartbeatDeployment,
  placeDeployment,
  releaseDeployLock,
} = await import("@/lib/deploy/repository");

// A transaction whose conditional UPDATE matched no queued row and whose
// follow-up read finds the row in `status` (or no row at all).
function unclaimed(status: string | null) {
  transaction.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: () => ({
          set: () => ({ where: () => ({ returning: async () => [] }) }),
        }),
        select: () => ({
          from: () => ({
            where: async () => (status === null ? [] : [{ status }]),
          }),
        }),
      })
  );
}

describe("claimDeployment", () => {
  it('maps unique violation to "busy"', async () => {
    transaction.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value"), {
        code: "23505",
        constraint_name: "deployments_one_running_per_env_idx",
      })
    );
    await expect(claimDeployment("d1")).resolves.toBe("busy");
  });

  it("rethrows other errors", async () => {
    transaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(claimDeployment("d1")).rejects.toThrow("connection lost");
  });

  it('returns "claimed" when the queued row was updated', async () => {
    transaction.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: () => ({
            set: () => ({
              where: () => ({ returning: async () => [{ id: "d1" }] }),
            }),
          }),
        })
    );
    await expect(claimDeployment("d1")).resolves.toBe("claimed");
  });

  it('returns "superseded" for a superseded row', async () => {
    unclaimed("superseded");
    await expect(claimDeployment("d1")).resolves.toBe("superseded");
  });

  it('returns "interrupted" for a row already running (redelivery)', async () => {
    unclaimed("running");
    await expect(claimDeployment("d1")).resolves.toBe("interrupted");
  });

  it('returns "finished" for a finished or missing row', async () => {
    unclaimed("success");
    await expect(claimDeployment("d1")).resolves.toBe("finished");
    unclaimed("failed");
    await expect(claimDeployment("d1")).resolves.toBe("finished");
    unclaimed(null);
    await expect(claimDeployment("d1")).resolves.toBe("finished");
  });
});

describe("failStaleRunningDeployments", () => {
  it("fails the stale rows and returns their run ids", async () => {
    const set = vi.fn(() => ({
      where: () => ({
        returning: async () => [{ runId: "r1" }, { runId: "r2" }],
      }),
    }));
    update.mockReturnValueOnce({ set });
    await expect(failStaleRunningDeployments(25 * 60_000)).resolves.toEqual([
      "r1",
      "r2",
    ]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });
});

describe("heartbeatDeployment", () => {
  function updating(rows: { id: string }[]) {
    update.mockReturnValueOnce({
      set: () => ({ where: () => ({ returning: async () => rows }) }),
    });
  }

  it("is true while the deployment is running", async () => {
    updating([{ id: "d1" }]);
    await expect(heartbeatDeployment("d1")).resolves.toBe(true);
  });

  it("is false when the deployment is no longer running", async () => {
    updating([]);
    await expect(heartbeatDeployment("d1")).resolves.toBe(false);
  });
});

describe("deriveTagState", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 10, minute));
  // A deployment that ran its script at `minute` and finished a minute later.
  function ran(id: string, tag: string, status: string, minute: number) {
    return {
      id,
      tag,
      status: status as "success" | "failed" | "running",
      startedAt: at(minute),
      scriptStartedAt: at(minute),
      finishedAt: status === "running" ? null : at(minute + 1),
    };
  }
  const history = [
    ran("d0", "T0", "success", 0),
    ran("d1", "T1", "success", 10),
    ran("d2", "T2", "failed", 20),
  ];

  it("after a failed deploy, current is the failed tag and rollback is the last good one", () => {
    expect(deriveTagState(history)).toEqual({
      currentTag: "T2",
      currentStatus: "failed",
      previousTag: "T1",
    });
  });

  it("does not depend on the input order", () => {
    expect(deriveTagState([...history].reverse())).toEqual(
      deriveTagState(history)
    );
  });

  it("a deployment that failed before its script started does not count", () => {
    const backupFailed = {
      id: "d3",
      tag: "T3",
      status: "failed" as const,
      startedAt: at(30),
      scriptStartedAt: null,
      finishedAt: at(31),
    };
    expect(deriveTagState([...history, backupFailed])).toEqual({
      currentTag: "T2",
      currentStatus: "failed",
      previousTag: "T1",
    });
  });

  it("after a success, rollback is the newest other successful tag", () => {
    expect(deriveTagState(history.slice(0, 2))).toEqual({
      currentTag: "T1",
      currentStatus: "success",
      previousTag: "T0",
    });
  });

  it("a redeploy of the current tag is skipped when picking the rollback tag", () => {
    expect(
      deriveTagState([...history.slice(0, 2), ran("d2", "T1", "success", 20)])
    ).toMatchObject({ currentTag: "T1", previousTag: "T0" });
  });

  it("orders by finish time, not by start time", () => {
    // d1 started earlier but finished after d2.
    const rows = [
      { ...ran("d1", "T1", "success", 0), finishedAt: at(30) },
      ran("d2", "T2", "success", 10),
    ];
    expect(deriveTagState(rows)).toMatchObject({
      currentTag: "T1",
      previousTag: "T2",
    });
  });

  it("a running deployment is current", () => {
    expect(
      deriveTagState([...history, ran("d3", "T3", "running", 30)])
    ).toEqual({
      currentTag: "T3",
      currentStatus: "running",
      previousTag: "T1",
    });
  });

  it("is empty without deployments", () => {
    expect(deriveTagState([])).toEqual({
      currentTag: null,
      currentStatus: null,
      previousTag: null,
    });
  });
});

// A transaction double that records every statement (op, table, values) and
// answers it from `answer`, so the tests can check which rows a held build
// and a release write.
type Recorded = {
  op: "select" | "insert" | "update" | "delete";
  table?: string;
  values?: Record<string, unknown>;
};

function recordingTx(answer: (r: Recorded) => unknown[]) {
  const ops: Recorded[] = [];
  const chain = (rec: Recorded) => {
    const c: Record<string, unknown> = {};
    for (const m of [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "for",
      "orderBy",
      "limit",
      "returning",
      "values",
      "set",
      "onConflictDoNothing",
    ]) {
      c[m] = (...args: unknown[]) => {
        if (m === "from") rec.table = getTableName(args[0] as never);
        if (m === "values" || m === "set") {
          rec.values = args[0] as Record<string, unknown>;
        }
        return c;
      };
    }
    // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are thenables; the double mimics one.
    c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => answer(rec))
        .then(ok, ko);
    return c;
  };
  const start =
    (op: Recorded["op"]) =>
    (table?: unknown): unknown => {
      const rec: Recorded = {
        op,
        ...(table ? { table: getTableName(table as never) } : {}),
      };
      ops.push(rec);
      return chain(rec);
    };
  const tx = {
    select: start("select"),
    insert: start("insert"),
    update: start("update"),
    delete: start("delete"),
  };
  transaction.mockImplementationOnce(
    async (fn: (t: unknown) => Promise<unknown>) => fn(tx)
  );
  return ops;
}

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const NOW = new Date("2026-11-05T03:00:00Z");
const activeLock = {
  environmentId: ENV,
  lockedBy: "u1",
  reason: "UAT",
  expiresAt: new Date("2026-11-05T10:00:00Z"),
  createdAt: new Date("2026-11-05T02:00:00Z"),
};

const placeInput = {
  targetId: "t1",
  environmentId: ENV,
  tag: "origin-main-abc1234",
  trigger: "auto" as const,
  userId: null,
  buildId: null,
  description: "Deploy app origin-main-abc1234 (auto)",
  now: NOW,
};

describe("placeDeployment", () => {
  it("records a held build with no run at all while locked", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "select") return [{ lock: activeLock, lockerName: "Budi" }];
      if (r.op === "insert") return [{ id: "dep-1" }];
      return [];
    });
    await expect(placeDeployment(placeInput)).resolves.toEqual({
      kind: "held",
      deploymentId: "dep-1",
      runId: null,
    });
    // No run row: Home attention and the success rate read only runs, so a
    // held build cannot clear a failure or count as a success.
    expect(ops.some((o) => o.op === "insert" && o.table === "runs")).toBe(
      false
    );
    const insert = ops.find((o) => o.op === "insert");
    expect(insert).toMatchObject({
      table: "deployments",
      values: { status: "held", runId: null },
    });
  });

  it("creates a started run and a queued deployment when not locked", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "select") return [];
      if (r.op === "insert") {
        return [{ id: r.table === "runs" ? "run-1" : "dep-1" }];
      }
      return [];
    });
    await expect(placeDeployment(placeInput)).resolves.toEqual({
      kind: "queued",
      deploymentId: "dep-1",
      runId: "run-1",
    });
    const inserts = ops.filter((o) => o.op === "insert");
    expect(inserts.map((o) => o.table)).toEqual(["runs", "deployments"]);
    expect(inserts[0]?.values).toMatchObject({ status: "started" });
    expect(inserts[1]?.values).toMatchObject({
      status: "queued",
      runId: "run-1",
    });
  });

  it("writes nothing for a manual deploy while locked", async () => {
    const ops = recordingTx((r) =>
      r.op === "select" ? [{ lock: activeLock, lockerName: "Budi" }] : []
    );
    const result = await placeDeployment({ ...placeInput, trigger: "manual" });
    expect(result.kind).toBe("locked");
    expect(ops.filter((o) => o.op !== "select")).toEqual([]);
  });
});

describe("releaseDeployLock", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 2, 0, s));
  const heldRows = [
    {
      id: "a1",
      targetId: "A",
      createdAt: at(1),
      tag: "origin-main-0000001",
      trigger: "auto",
      componentKey: "app",
    },
    {
      id: "a2",
      targetId: "A",
      createdAt: at(2),
      tag: "origin-main-0000002",
      trigger: "auto",
      componentKey: "app",
    },
  ];

  it("creates exactly one run, for the newest held build, and none for the superseded", async () => {
    let runs = 0;
    const ops = recordingTx((r) => {
      if (r.op === "delete") return [activeLock];
      if (r.op === "select") return heldRows;
      if (r.op === "insert" && r.table === "runs") {
        runs += 1;
        return [{ id: `run-${runs}` }];
      }
      if (r.op === "update" && r.values?.status === "queued") {
        return [{ id: "a2" }];
      }
      if (r.op === "update" && r.values?.status === "superseded") {
        return [{ id: "a1" }];
      }
      if (r.op === "update" && "runId" in (r.values ?? {})) {
        return [{ id: "a2" }];
      }
      return [];
    });
    const released = await releaseDeployLock(ENV);
    expect(released).toEqual({
      lock: activeLock,
      queued: [{ deploymentId: "a2", runId: "run-1" }],
      superseded: ["a1"],
    });
    const runInserts = ops.filter((o) => o.op === "insert");
    expect(runInserts).toHaveLength(1);
    expect(runInserts[0]).toMatchObject({
      table: "runs",
      values: {
        environmentId: ENV,
        status: "started",
        kind: "deploy",
        description: "Deploy app origin-main-0000002 (auto)",
      },
    });
    expect(
      ops.some((o) => o.op === "update" && o.values?.runId === "run-1")
    ).toBe(true);
  });

  it("writes nothing when the lock is already gone (concurrent release)", async () => {
    const ops = recordingTx((r) => (r.op === "delete" ? [] : []));
    await expect(releaseDeployLock(ENV)).resolves.toBeNull();
    expect(ops.map((o) => o.op)).toEqual(["delete"]);
  });
});
