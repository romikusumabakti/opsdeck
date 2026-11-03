import { describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
const update = vi.fn();
vi.mock("@/lib/db", () => ({ db: { transaction, update } }));

const { claimDeployment, failStaleRunningDeployments } = await import(
  "@/lib/deploy/repository"
);

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
