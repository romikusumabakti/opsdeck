import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
const update = vi.fn();
const select = vi.fn();
vi.mock("@/lib/db", () => ({ db: { transaction, update, select } }));

const {
  claimDeployment,
  deriveTagState,
  failStaleRunningDeployments,
  heartbeatDeployment,
  insertDeployLock,
  listServicesInDeployDir,
  placeDeployment,
  releaseDeployLock,
  supersedeHeldDeployments,
} = await import("@/lib/deploy/repository");

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
  lockMode?: string;
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
        if (m === "for") rec.lockMode = args[0] as string;
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
      released: null,
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
      released: null,
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
    // Only the conditional delete of an expired lock, which matched nothing.
    expect(ops.filter((o) => o.op !== "select")).toEqual([
      { op: "delete", table: "environment_deploy_locks" },
    ]);
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

// The statements on each table, in order, as "op table".
const trail = (ops: Recorded[]) => ops.map((o) => `${o.op} ${o.table}`);

describe("placeDeployment with an expired, unswept lock", () => {
  const expiredLock = { ...activeLock, expiresAt: new Date(NOW.getTime() - 1) };

  it("releases it first, so the held build is queued before the new request", async () => {
    // 17:00: held v4 exists, the lock expired, a manual v5 is placed.
    let runCount = 0;
    const ops = recordingTx((r) => {
      if (r.op === "delete") return [expiredLock];
      if (r.op === "select" && r.table === "deployments") {
        return [
          {
            id: "v4",
            targetId: "t1",
            createdAt: new Date("2026-11-05T09:00:00Z"),
            tag: "origin-main-0000004",
            trigger: "auto",
            componentKey: "app",
          },
        ];
      }
      if (r.op === "select") return []; // the lock is gone now
      if (r.op === "update" && r.values?.status === "queued") {
        return [{ id: "v4" }];
      }
      if (r.op === "insert" && r.table === "runs") {
        runCount += 1;
        return [{ id: `run-${runCount}` }];
      }
      if (r.op === "insert") return [{ id: "v5" }];
      return [];
    });
    const result = await placeDeployment({
      ...placeInput,
      trigger: "manual",
      tag: "origin-main-0000005",
      userId: "u2",
    });
    expect(result).toEqual({
      kind: "queued",
      deploymentId: "v5",
      runId: "run-2",
      released: {
        lock: expiredLock,
        queued: [{ deploymentId: "v4", runId: "run-1" }],
        superseded: [],
      },
    });
    const t = trail(ops);
    // Lock table first, then deployments (see the lock order note).
    expect(t[0]).toBe("delete environment_deploy_locks");
    const v4Queued = ops.findIndex(
      (o) => o.op === "update" && o.values?.status === "queued"
    );
    const v5Inserted = ops.findIndex(
      (o) => o.op === "insert" && o.table === "deployments"
    );
    expect(v4Queued).toBeGreaterThan(-1);
    expect(v5Inserted).toBeGreaterThan(v4Queued);
    // The released run belongs to nobody (cause "expired").
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ userId: null });
  });

  it("deletes only an expired lock: an active one still holds an auto build", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "delete") return []; // not expired: nothing matched
      if (r.op === "select") return [{ lock: activeLock, lockerName: "Budi" }];
      if (r.op === "insert") return [{ id: "dep-1" }];
      return [];
    });
    await expect(placeDeployment(placeInput)).resolves.toMatchObject({
      kind: "held",
      released: null,
    });
    expect(trail(ops).slice(0, 2)).toEqual([
      "delete environment_deploy_locks",
      "select environment_deploy_locks",
    ]);
    expect(ops[1]?.lockMode).toBe("share");
  });
});

describe("releaseDeployLock run owner", () => {
  it("gives the released run to the actor who unlocked", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "delete") return [activeLock];
      if (r.op === "select") {
        return [
          {
            id: "a1",
            targetId: "A",
            createdAt: NOW,
            tag: "origin-main-0000001",
            trigger: "auto",
            componentKey: "app",
          },
        ];
      }
      if (r.op === "update" && r.values?.status === "queued") {
        return [{ id: "a1" }];
      }
      if (r.op === "insert") return [{ id: "run-1" }];
      return [];
    });
    await releaseDeployLock(ENV, {}, "u-owner");
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ userId: "u-owner" });
  });
});

const queuedRows = [
  { id: "q-auto", trigger: "auto", runId: "r-auto", environmentId: ENV },
  { id: "q-man", trigger: "manual", runId: "r-man", environmentId: ENV },
  { id: "q-rb", trigger: "rollback", runId: "r-rb", environmentId: ENV },
];

describe("insertDeployLock", () => {
  const newLock = {
    environmentId: ENV,
    lockedBy: "u1",
    reason: "UAT",
    expiresAt: new Date("2026-11-05T10:00:00Z"),
    createdAt: NOW,
  };

  it("holds the queued auto deploys and cancels queued manual deploys and rollbacks", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "insert") return [{ id: ENV }];
      if (r.op === "select" && r.table === "users") return [{ name: "Budi" }];
      if (r.op === "select" && r.table === "deployments") return queuedRows;
      if (r.op === "update" && r.values?.status === "held") {
        return [{ id: "q-auto" }];
      }
      if (r.op === "update" && r.values?.status === "failed") {
        return r.table === "deployments"
          ? [{ id: "q-man" }, { id: "q-rb" }]
          : [];
      }
      return [];
    });
    await expect(insertDeployLock(newLock)).resolves.toEqual({
      held: ["q-auto"],
      cancelled: ["q-man", "q-rb"],
    });
    // Lock order: the lock row before any deployment row.
    expect(trail(ops)[0]).toBe("insert environment_deploy_locks");
    expect(
      ops.find((o) => o.op === "select" && o.table === "deployments")?.lockMode
    ).toBe("update");
    // Held: no run (it never started); the run row goes after the link is
    // cleared, as deleting a run cascades to its deployment.
    const held = ops.findIndex(
      (o) => o.op === "update" && o.values?.status === "held"
    );
    expect(ops[held]?.values).toEqual({ status: "held", runId: null });
    const runDelete = ops.findIndex(
      (o) => o.op === "delete" && o.table === "runs"
    );
    expect(runDelete).toBeGreaterThan(held);
    // Cancelled: the deployment and its run fail with the lock's name and
    // reason only.
    expect(
      ops.find(
        (o) =>
          o.op === "update" &&
          o.table === "deployments" &&
          o.values?.status === "failed"
      )
    ).toBeDefined();
    const runFail = ops.find((o) => o.op === "update" && o.table === "runs");
    expect(runFail?.values).toMatchObject({
      status: "failed",
      errorMessage: "Cancelled: deploys locked by Budi — UAT",
    });
  });

  it("changes nothing when the environment is already locked", async () => {
    const ops = recordingTx(() => []);
    await expect(insertDeployLock(newLock)).resolves.toBeNull();
    expect(trail(ops)).toEqual(["insert environment_deploy_locks"]);
  });
});

describe("claimDeployment", () => {
  // Answers a claim transaction: the deployment row (or none), the lock (or
  // none), and whether the conditional UPDATE to running matched.
  function claimTx(opts: {
    row: (typeof queuedRows)[number] | null;
    status?: string;
    lock?: typeof activeLock | null;
    updated?: boolean;
  }) {
    return recordingTx((r) => {
      if (r.op === "select" && r.table === "deployments") {
        return opts.row
          ? [{ ...opts.row, status: opts.status ?? "queued" }]
          : [];
      }
      if (r.op === "select" && r.table === "environment_deploy_locks") {
        return opts.lock ? [{ lock: opts.lock, lockerName: "Budi" }] : [];
      }
      if (r.op === "update" && r.values?.status === "running") {
        return opts.updated === false ? [] : [{ id: opts.row?.id }];
      }
      if (r.op === "update" && r.values?.status === "held") {
        return [{ id: opts.row?.id }];
      }
      if (r.op === "update" && r.values?.status === "failed") {
        return r.table === "deployments" ? [{ id: opts.row?.id }] : [];
      }
      return [];
    });
  }
  // Real-time expiry: claimDeployment compares against the wall clock.
  const liveLock = {
    ...activeLock,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  const [auto, manual] = queuedRows as [
    (typeof queuedRows)[number],
    (typeof queuedRows)[number],
  ];

  it('maps unique violation to "busy"', async () => {
    transaction.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value"), {
        code: "23505",
        constraint_name: "deployments_one_running_per_env_idx",
      })
    );
    await expect(claimDeployment("d1", "r1")).resolves.toBe("busy");
  });

  it("rethrows other errors", async () => {
    transaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(claimDeployment("d1", "r1")).rejects.toThrow(
      "connection lost"
    );
  });

  it('returns "claimed" when unlocked, reading the lock FOR SHARE first', async () => {
    const ops = claimTx({ row: auto, lock: null });
    await expect(claimDeployment("q-auto", "r-auto")).resolves.toBe("claimed");
    const lockRead = ops.findIndex(
      (o) => o.table === "environment_deploy_locks"
    );
    expect(ops[lockRead]?.lockMode).toBe("share");
    const running = ops.findIndex((o) => o.values?.status === "running");
    expect(running).toBeGreaterThan(lockRead);
  });

  it('holds a queued auto deploy while locked: "held", run deleted, never running', async () => {
    const ops = claimTx({ row: auto, lock: liveLock });
    await expect(claimDeployment("q-auto", "r-auto")).resolves.toBe("held");
    expect(ops.some((o) => o.values?.status === "running")).toBe(false);
    expect(ops.some((o) => o.op === "delete" && o.table === "runs")).toBe(true);
  });

  it('cancels a queued manual deploy while locked: "cancelled"', async () => {
    const ops = claimTx({ row: manual, lock: liveLock });
    await expect(claimDeployment("q-man", "r-man")).resolves.toBe("cancelled");
    expect(ops.some((o) => o.values?.status === "running")).toBe(false);
    expect(
      ops.find((o) => o.op === "update" && o.table === "runs")?.values
    ).toMatchObject({
      status: "failed",
      errorMessage: "Cancelled: deploys locked by Budi — UAT",
    });
  });

  it("an expired lock does not stop the claim", async () => {
    claimTx({
      row: auto,
      lock: { ...activeLock, expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(claimDeployment("q-auto", "r-auto")).resolves.toBe("claimed");
  });

  it("re-lock between two released claims: the second target ends held, not deployed", async () => {
    // The release queued A and B; A is claimed, then the owner locks again
    // before B's job runs.
    claimTx({ row: { ...auto, id: "A", runId: "rA" }, lock: null });
    await expect(claimDeployment("A", "rA")).resolves.toBe("claimed");
    const ops = claimTx({
      row: { ...auto, id: "B", runId: "rB" },
      lock: liveLock,
    });
    await expect(claimDeployment("B", "rB")).resolves.toBe("held");
    expect(ops.some((o) => o.values?.status === "running")).toBe(false);
  });

  it("ignores a job whose run is not the deployment's (held and released since)", async () => {
    const ops = claimTx({ row: { ...auto, runId: "r-new" }, lock: null });
    await expect(claimDeployment("q-auto", "r-old")).resolves.toBe("finished");
    expect(ops.some((o) => o.op === "update")).toBe(false);
  });

  it('returns "finished" for a missing row', async () => {
    claimTx({ row: null });
    await expect(claimDeployment("d1", "r1")).resolves.toBe("finished");
  });

  it.each([
    ["superseded", "superseded"],
    ["running", "interrupted"],
    ["success", "finished"],
    ["failed", "finished"],
    ["queued", "busy"],
  ])('maps a row left %s to "%s"', async (status, outcome) => {
    claimTx({ row: auto, status, lock: null, updated: false });
    await expect(claimDeployment("q-auto", "r-auto")).resolves.toBe(outcome);
  });
});

describe("supersedeHeldDeployments", () => {
  it("supersedes only the target's held deployments", async () => {
    const ops = recordingTx(() => [{ id: "h1" }]);
    let count = 0;
    await transaction(async (tx: never) => {
      count = await supersedeHeldDeployments("t1", tx);
    });
    expect(count).toBe(1);
    expect(ops).toEqual([
      {
        op: "update",
        table: "deployments",
        values: expect.objectContaining({ status: "superseded" }),
      },
    ]);
  });
});

describe("auto run actor (triggered_by)", () => {
  const BUILD = "0197f3a0-1b2c-7def-8000-0123456789b1";

  it("gives an auto run the pusher of its build", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "select" && r.table === "builds") {
        return [{ pushedBy: "romi" }];
      }
      if (r.op === "select") return [];
      if (r.op === "insert") {
        return [{ id: r.table === "runs" ? "run-1" : "dep-1" }];
      }
      return [];
    });
    await placeDeployment({ ...placeInput, buildId: BUILD });
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ userId: null, triggeredBy: "romi" });
  });

  it("leaves triggered_by null when the build has no pusher", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "select" && r.table === "builds")
        return [{ pushedBy: null }];
      if (r.op === "select") return [];
      if (r.op === "insert") {
        return [{ id: r.table === "runs" ? "run-1" : "dep-1" }];
      }
      return [];
    });
    await placeDeployment({ ...placeInput, buildId: BUILD });
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ triggeredBy: null });
  });

  it("gives an auto run the commit author email when the pusher is unknown", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "select" && r.table === "builds") {
        return [{ pushedBy: null, commitAuthorEmail: " Romi@DSS.test" }];
      }
      if (r.op === "select") return [];
      if (r.op === "insert") {
        return [{ id: r.table === "runs" ? "run-1" : "dep-1" }];
      }
      return [];
    });
    await placeDeployment({ ...placeInput, buildId: BUILD });
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ userId: null, triggeredBy: "romi@dss.test" });
  });

  it("does not read the build for a manual run", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "select") return [];
      if (r.op === "insert") {
        return [{ id: r.table === "runs" ? "run-1" : "dep-1" }];
      }
      return [];
    });
    await placeDeployment({
      ...placeInput,
      trigger: "manual",
      userId: "u1",
      buildId: BUILD,
    });
    expect(ops.some((o) => o.table === "builds")).toBe(false);
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ userId: "u1", triggeredBy: null });
  });

  it("a held build released later gives its new run the same pusher", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "delete") return [activeLock];
      if (r.op === "select") {
        return [
          {
            id: "a1",
            targetId: "A",
            createdAt: NOW,
            tag: "origin-main-0000001",
            trigger: "auto",
            componentKey: "app",
            pushedBy: "romi",
          },
        ];
      }
      if (r.op === "update" && r.values?.status === "queued") {
        return [{ id: "a1" }];
      }
      if (r.op === "insert") return [{ id: "run-1" }];
      return [];
    });
    await releaseDeployLock(ENV, {}, "u-owner");
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ userId: "u-owner", triggeredBy: "romi" });
  });

  it("a held build released later falls back to its commit author email", async () => {
    const ops = recordingTx((r) => {
      if (r.op === "delete") return [activeLock];
      if (r.op === "select") {
        return [
          {
            id: "a1",
            targetId: "A",
            createdAt: NOW,
            tag: "origin-main-0000001",
            trigger: "auto",
            componentKey: "app",
            pushedBy: null,
            commitAuthorEmail: "Romi@DSS.test",
          },
        ];
      }
      if (r.op === "update" && r.values?.status === "queued") {
        return [{ id: "a1" }];
      }
      if (r.op === "insert") return [{ id: "run-1" }];
      return [];
    });
    await releaseDeployLock(ENV, {}, "u-owner");
    expect(
      ops.find((o) => o.op === "insert" && o.table === "runs")?.values
    ).toMatchObject({ triggeredBy: "romi@dss.test" });
  });
});

describe("listServicesInDeployDir", () => {
  it("returns the union of the targets' services, deduplicated and sorted", async () => {
    select.mockReturnValueOnce({
      from: () => ({
        where: async () => [
          { services: ["worker", "backend"] },
          { services: ["frontend", "backend"] },
        ],
      }),
    });
    await expect(listServicesInDeployDir("s1", "/opt/app")).resolves.toEqual([
      "backend",
      "frontend",
      "worker",
    ]);
  });
});
