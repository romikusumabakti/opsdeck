import { describe, expect, it, vi } from "vitest";

const transaction = vi.fn();
vi.mock("@/lib/db", () => ({ db: { transaction } }));

const { claimDeployment } = await import("@/lib/deploy/repository");

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

  it('returns "gone" when no queued row was updated', async () => {
    transaction.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: () => ({
            set: () => ({ where: () => ({ returning: async () => [] }) }),
          }),
        })
    );
    await expect(claimDeployment("d1")).resolves.toBe("gone");
  });
});
