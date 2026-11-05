import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

// requestDeployment against a mocked repository: the lock decision and the
// inserts happen in one transaction there (placeDeployment); this checks what
// the service does with each outcome.

const TARGET_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const BUILD_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const TAG = "origin-kestrel-development-abc1234";

const repo = vi.hoisted(() => ({
  getTarget: vi.fn(),
  placeDeployment: vi.fn(),
}));
vi.mock("@/lib/deploy/repository", () => repo);

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue", () => queue);

const { requestDeployment } = await import("@/server/services/deployments");

const lock = {
  environmentId: ENV_ID,
  lockedBy: "0197f3a0-1b2c-7def-8000-0123456789f1",
  lockerName: "Budi",
  reason: "UAT with the client until 5 pm",
  expiresAt: new Date("2026-11-05T10:00:00Z"),
  createdAt: new Date("2026-11-05T02:00:00Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  repo.getTarget.mockResolvedValue({
    id: TARGET_ID,
    environmentId: ENV_ID,
    componentKey: "dplk-accounting",
  });
});

const request = (trigger: "auto" | "manual" | "rollback") =>
  requestDeployment({
    targetId: TARGET_ID,
    tag: TAG,
    trigger,
    userId: trigger === "auto" ? null : "user-1",
    buildId: BUILD_ID,
  });

describe("requestDeployment", () => {
  it("queues and enqueues when the environment is not locked", async () => {
    repo.placeDeployment.mockResolvedValue({
      kind: "queued",
      deploymentId: "dep-1",
      runId: "run-1",
    });
    await expect(request("auto")).resolves.toEqual({
      deploymentId: "dep-1",
      runId: "run-1",
      status: "queued",
    });
    expect(repo.placeDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        environmentId: ENV_ID,
        tag: TAG,
        trigger: "auto",
        buildId: BUILD_ID,
        description: `Deploy dplk-accounting ${TAG} (auto)`,
      })
    );
    expect(queue.enqueue).toHaveBeenCalledWith("deploy/run.requested", {
      deploymentId: "dep-1",
      runId: "run-1",
    });
  });

  it("holds an auto deploy while locked: no job, so it never runs", async () => {
    repo.placeDeployment.mockResolvedValue({
      kind: "held",
      deploymentId: "dep-2",
      runId: "run-2",
    });
    await expect(request("auto")).resolves.toEqual({
      deploymentId: "dep-2",
      runId: "run-2",
      status: "held",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("holds two notifications for one target in the same second, enqueuing neither", async () => {
    repo.placeDeployment
      .mockResolvedValueOnce({ kind: "held", deploymentId: "d1", runId: "r1" })
      .mockResolvedValueOnce({ kind: "held", deploymentId: "d2", runId: "r2" });
    await Promise.all([request("auto"), request("auto")]);
    expect(repo.placeDeployment).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each(["manual", "rollback"] as const)(
    "refuses a %s deploy while locked with a 409 naming holder, reason and expiry",
    async (trigger) => {
      repo.placeDeployment.mockResolvedValue({ kind: "locked", lock });
      const error = await request(trigger).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HTTPException);
      const http = error as HTTPException;
      expect(http.status).toBe(409);
      expect(http.message).toContain("Budi");
      expect(http.message).toContain("UAT with the client until 5 pm");
      expect(http.message).toMatch(/2026/);
      expect(queue.enqueue).not.toHaveBeenCalled();
    }
  );

  it("rejects an invalid tag before recording anything", async () => {
    await expect(
      requestDeployment({
        targetId: TARGET_ID,
        tag: "latest",
        trigger: "manual",
        userId: null,
        buildId: null,
      })
    ).rejects.toThrow();
    expect(repo.placeDeployment).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
