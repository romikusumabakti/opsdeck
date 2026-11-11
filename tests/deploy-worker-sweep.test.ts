import { describe, expect, it, vi } from "vitest";

// startWorker must sweep deployments a dead worker left `running`, and a sweep
// failure must never stop the worker from starting.
const deploy = vi.hoisted(() => ({ failStaleDeployments: vi.fn() }));
vi.mock("@/lib/jobs/deploy", () => deploy);
const provisioning = vi.hoisted(() => ({
  failStaleProvisionRuns: vi.fn(async () => 0),
}));
vi.mock("@/lib/provisioning/repository", () => provisioning);
const teardown = vi.hoisted(() => ({
  failStaleTeardownRuns: vi.fn(async () => 0),
}));
vi.mock("@/lib/teardown/repository", () => teardown);
vi.mock("@/lib/jobs/processor", () => ({ processJob: vi.fn() }));
const queue = vi.hoisted(() => ({
  TASKS_QUEUE: "test",
  createRedisConnection: vi.fn(),
  scheduleJiraSweep: vi.fn(),
  scheduleDeployLockSweep: vi.fn(async () => {}),
  scheduleInstanceUpdateCheck: vi.fn(async () => {}),
  scheduleEnvironmentArchivePrune: vi.fn(async () => {}),
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

// startWorker is idempotent (one worker per module instance), so each test
// that needs a fresh worker re-imports the module.
async function freshStartWorker() {
  vi.resetModules();
  return (await import("@/lib/jobs/worker")).startWorker;
}

const { startWorker: firstStartWorker } = await import("@/lib/jobs/worker");

describe("startWorker", () => {
  it("sweeps stale running deployments, and survives a sweep failure", async () => {
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Keep startWorker's shutdown hooks off the test process.
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    deploy.failStaleDeployments.mockRejectedValue(new Error("db down"));

    expect(firstStartWorker()).not.toBeNull();
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
    const startWorker = await freshStartWorker();
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
      // The hourly instance update check is registered on boot too.
      expect(queue.scheduleInstanceUpdateCheck).toHaveBeenCalledTimes(1);
    });

    errors.mockRestore();
    once.mockRestore();
    vi.unstubAllEnvs();
  });

  it("survives a lock sweep or scheduling failure", async () => {
    const startWorker = await freshStartWorker();
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

describe("startWorker provision sweep", () => {
  it("fails provision runs left started, and survives a failure", async () => {
    const startWorker = await freshStartWorker();
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    deploy.failStaleDeployments.mockResolvedValue(undefined);
    provisioning.failStaleProvisionRuns.mockRejectedValue(new Error("db down"));

    expect(startWorker()).not.toBeNull();
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        "Failed to sweep stale provision runs:",
        expect.any(Error)
      )
    );
    expect(provisioning.failStaleProvisionRuns).toHaveBeenCalledTimes(1);

    errors.mockRestore();
    once.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe("startWorker teardown sweep and archive prune", () => {
  it("fails teardown runs left started, schedules the daily prune, and survives failures", async () => {
    const startWorker = await freshStartWorker();
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const once = vi.spyOn(process, "once").mockImplementation(() => process);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    deploy.failStaleDeployments.mockResolvedValue(undefined);
    teardown.failStaleTeardownRuns.mockRejectedValue(new Error("db down"));
    queue.scheduleEnvironmentArchivePrune.mockRejectedValue(
      new Error("redis down")
    );

    expect(startWorker()).not.toBeNull();
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith(
        "Failed to sweep stale teardown runs:",
        expect.any(Error)
      );
      expect(errors).toHaveBeenCalledWith(
        "Failed to schedule the environment archive prune:",
        expect.any(Error)
      );
    });
    expect(teardown.failStaleTeardownRuns).toHaveBeenCalledTimes(1);
    expect(queue.scheduleEnvironmentArchivePrune).toHaveBeenCalledTimes(1);

    errors.mockRestore();
    once.mockRestore();
    vi.unstubAllEnvs();
  });
});
