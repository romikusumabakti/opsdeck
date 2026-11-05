import { describe, expect, it, vi } from "vitest";

// startWorker must sweep deployments a dead worker left `running`, and a sweep
// failure must never stop the worker from starting.
const deploy = vi.hoisted(() => ({ failStaleDeployments: vi.fn() }));
vi.mock("@/lib/jobs/deploy", () => deploy);
vi.mock("@/lib/jobs/processor", () => ({ processJob: vi.fn() }));
const queue = vi.hoisted(() => ({
  TASKS_QUEUE: "test",
  createRedisConnection: vi.fn(),
  scheduleJiraSweep: vi.fn(),
  scheduleDeployLockSweep: vi.fn(async () => {}),
}));
vi.mock("@/lib/queue", () => queue);
const locks = vi.hoisted(() => ({ sweepExpiredLocks: vi.fn(async () => 0) }));
vi.mock("@/lib/deploy/lock-release", () => locks);
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

describe("startWorker deploy lock sweep", () => {
  it("schedules the 60 s lock sweep and releases locks that expired while it was down", async () => {
    // startWorker is idempotent (cached on globalThis); start a fresh one.
    delete (globalThis as { __tasksWorker?: unknown }).__tasksWorker;
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    deploy.failStaleDeployments.mockResolvedValue(undefined);
    locks.sweepExpiredLocks.mockResolvedValue(1);
    queue.scheduleDeployLockSweep.mockResolvedValue(undefined);

    expect(startWorker()).not.toBeNull();
    await vi.waitFor(() => {
      expect(queue.scheduleDeployLockSweep).toHaveBeenCalledTimes(1);
      expect(locks.sweepExpiredLocks).toHaveBeenCalledTimes(1);
    });

    errors.mockRestore();
    once.mockRestore();
    vi.unstubAllEnvs();
  });

  it("survives a lock sweep or scheduling failure", async () => {
    delete (globalThis as { __tasksWorker?: unknown }).__tasksWorker;
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    deploy.failStaleDeployments.mockResolvedValue(undefined);
    locks.sweepExpiredLocks.mockRejectedValue(new Error("db down"));
    queue.scheduleDeployLockSweep.mockRejectedValue(new Error("redis down"));

    expect(startWorker()).not.toBeNull();
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith(
        "Failed to sweep expired deploy locks:",
        expect.any(Error)
      );
      expect(errors).toHaveBeenCalledWith(
        "Failed to schedule the deploy lock sweep:",
        expect.any(Error)
      );
    });

    errors.mockRestore();
    once.mockRestore();
    vi.unstubAllEnvs();
  });
});
