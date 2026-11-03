import { describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
const update = vi.fn();
vi.mock("@/lib/db", () => ({ db: { transaction, update } }));

const {
  claimDeployment,
  deriveTagState,
  failStaleRunningDeployments,
  heartbeatDeployment,
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
