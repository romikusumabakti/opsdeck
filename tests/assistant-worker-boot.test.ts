import { describe, expect, it, vi } from "vitest";

// startAssistantWorker must fail turns a dead worker left queued/streaming and
// evict old snapshots on boot; a failure of either must only be logged.
const store = vi.hoisted(() => ({
  failStaleAssistantMessages: vi.fn(async () => 0),
}));
vi.mock("@/lib/assistant/turn-store", () => store);
const snapshot = vi.hoisted(() => ({ evictSnapshots: vi.fn(async () => 0) }));
vi.mock("@/lib/assistant/snapshot", () => snapshot);
vi.mock("@/lib/assistant/run-turn", () => ({ runTurn: vi.fn() }));
const shutdown = vi.hoisted(() => ({ registerShutdown: vi.fn() }));
vi.mock("@/lib/jobs/shutdown", () => shutdown);
vi.mock("@/lib/queue", () => ({ createRedisConnection: vi.fn() }));
const workers = vi.hoisted(() => ({
  created: [] as Array<{ name: string; opts: unknown }>,
}));
vi.mock("bullmq", () => ({
  Queue: class {},
  Worker: class {
    constructor(name: string, _processor: unknown, opts: unknown) {
      workers.created.push({ name, opts });
    }
    on() {}
    async close() {}
  },
}));

// startAssistantWorker is idempotent per module instance.
async function freshStart() {
  vi.resetModules();
  return (await import("@/lib/assistant/queue")).startAssistantWorker;
}

describe("startAssistantWorker", () => {
  it("stale streaming messages are failed on boot", async () => {
    const start = await freshStart();
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.failStaleAssistantMessages.mockResolvedValue(2);

    expect(start()).not.toBeNull();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("[assistant] failed 2 stale turns")
    );
    expect(store.failStaleAssistantMessages).toHaveBeenCalledTimes(1);
    expect(snapshot.evictSnapshots).toHaveBeenCalledTimes(1);
    expect(workers.created.at(-1)).toMatchObject({
      name: "menara-assistant",
      opts: { concurrency: 2 },
    });
    expect(shutdown.registerShutdown).toHaveBeenCalled();

    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("only logs when the boot sweep or the eviction fails", async () => {
    const start = await freshStart();
    vi.stubEnv("REDIS_URL", "redis://test:6379");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    store.failStaleAssistantMessages.mockRejectedValue(new Error("db down"));
    snapshot.evictSnapshots.mockRejectedValue(new Error("disk gone"));

    expect(start()).not.toBeNull();
    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith(
        "Failed to sweep stale assistant messages:",
        expect.any(Error)
      );
      expect(errors).toHaveBeenCalledWith(
        "Failed to evict assistant snapshots:",
        expect.any(Error)
      );
    });

    errors.mockRestore();
    vi.unstubAllEnvs();
  });

  it("does not start without REDIS_URL", async () => {
    const start = await freshStart();
    vi.stubEnv("REDIS_URL", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.failStaleAssistantMessages.mockClear();

    expect(start()).toBeNull();
    expect(store.failStaleAssistantMessages).not.toHaveBeenCalled();

    warn.mockRestore();
    vi.unstubAllEnvs();
  });
});
