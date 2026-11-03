import { describe, expect, it, vi } from "vitest";

// startWorker must sweep deployments a dead worker left `running`, and a sweep
// failure must never stop the worker from starting.
const deploy = vi.hoisted(() => ({ failStaleDeployments: vi.fn() }));
vi.mock("@/lib/jobs/deploy", () => deploy);
vi.mock("@/lib/jobs/processor", () => ({ processJob: vi.fn() }));
vi.mock("@/lib/queue", () => ({
  TASKS_QUEUE: "test",
  createRedisConnection: vi.fn(),
  scheduleJiraSweep: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));
vi.mock("bullmq", () => ({
  Worker: class {
    on() {}
    async close() {}
  },
}));

const { startWorker } = await import("@/lib/jobs/worker");

describe("startWorker", () => {
  it("sweeps stale running deployments, and survives a sweep failure", async () => {
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Keep startWorker's shutdown hooks off the test process.
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    deploy.failStaleDeployments.mockRejectedValue(new Error("db down"));

    expect(startWorker()).not.toBeNull();
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        "Failed to sweep stale deployments:",
        expect.any(Error)
      )
    );
    expect(deploy.failStaleDeployments).toHaveBeenCalledTimes(1);

    errors.mockRestore();
    once.mockRestore();
    vi.unstubAllEnvs();
  });
});
