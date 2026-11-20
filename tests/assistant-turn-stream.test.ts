import type { UIMessageChunk } from "ai";
import type { Publisher, Subscriber } from "resumable-stream/generic";
import { createResumableStreamContext } from "resumable-stream/generic";
import { describe, expect, it, vi } from "vitest";
import {
  hasTurnStream,
  loggingPublisher,
  loggingSubscriber,
  publishTurnStream,
  resumeTurnStream,
} from "@/lib/assistant/turn-stream";

// The turn stream over an in-memory pub/sub with Redis semantics: a channel
// delivers to the callbacks subscribed at publish time, asynchronously, and
// INCR on a non-integer fails like Redis.

function memoryRedis() {
  const values = new Map<string, string>();
  const channels = new Map<string, Set<(message: string) => void>>();
  const publisher: Publisher = {
    connect: async () => {},
    publish: async (channel, message) => {
      const listeners = [...(channels.get(channel) ?? [])];
      queueMicrotask(() => {
        for (const listener of listeners) listener(message);
      });
      return listeners.length;
    },
    set: async (key, value) => {
      values.set(key, value);
      return "OK";
    },
    get: async (key) => values.get(key) ?? null,
    incr: async (key) => {
      const next = Number(values.get(key) ?? "0") + 1;
      if (!Number.isInteger(next)) {
        throw new Error("ERR value is not an integer or out of range");
      }
      values.set(key, String(next));
      return next;
    },
  };
  const subscriber = (): Subscriber => {
    const mine = new Map<string, (message: string) => void>();
    return {
      connect: async () => {},
      subscribe: async (channel, callback) => {
        mine.set(channel, callback);
        const set = channels.get(channel) ?? new Set();
        set.add(callback);
        channels.set(channel, set);
      },
      unsubscribe: async (channel) => {
        const callback = mine.get(channel);
        if (callback) channels.get(channel)?.delete(callback);
        mine.delete(channel);
      },
    };
  };
  return createResumableStreamContext({
    waitUntil: null,
    publisher,
    subscriber: subscriber(),
  });
}

function channel() {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    write: (chunk: UIMessageChunk) => controller.enqueue(chunk),
    close: () => controller.close(),
  };
}

const delta = (n: number): UIMessageChunk => ({
  type: "text-delta",
  id: "t1",
  delta: `part ${n} `,
});

/** The JSON of each `data:` frame, the closing [DONE] excluded. */
function frames(sse: string): unknown[] {
  return sse
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
}

async function textOf(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/** Until `check` holds, a macrotask at a time (bounded). */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never held");
}

/**
 * Two ioredis-shaped clients over one in-memory bus: the publisher's
 * commands, and the subscriber's "message" events and (un)subscribe.
 */
function ioredisLike(options: { unsubscribeFails?: boolean } = {}) {
  const values = new Map<string, string>();
  const subscribed = new Set<string>();
  const listeners = new Set<(channel: string, message: string) => void>();
  let readsFail = false;
  const publisher = {
    publish: async (channel: string, message: string) => {
      const active = subscribed.has(channel) ? [...listeners] : [];
      queueMicrotask(() => {
        for (const listener of active) listener(channel, message);
      });
      return active.length;
    },
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
    get: async (key: string) => {
      if (readsFail) throw new Error("NOPERM this user has no permissions");
      return values.get(key) ?? null;
    },
    incr: async (key: string) => {
      const next = Number(values.get(key) ?? "0") + 1;
      values.set(key, String(next));
      return next;
    },
  };
  const subscriber = {
    on: (
      _event: string,
      listener: (channel: string, message: string) => void
    ) => listeners.add(listener),
    removeListener: (
      _event: string,
      listener: (channel: string, message: string) => void
    ) => listeners.delete(listener),
    subscribe: async (channel: string) => {
      subscribed.add(channel);
      return subscribed.size;
    },
    unsubscribe: async (channel: string) => {
      subscribed.delete(channel);
      if (options.unsubscribeFails) {
        throw new Error("READONLY You can't write against a read only replica");
      }
      return subscribed.size;
    },
  };
  return {
    publisher: publisher as unknown as Parameters<typeof loggingPublisher>[0],
    subscriber: subscriber as unknown as Parameters<
      typeof loggingSubscriber
    >[0],
    listeners: () => listeners.size,
    failReads: () => {
      readsFail = true;
    },
  };
}

describe("turn stream", () => {
  it("a follower that joins mid-stream gets the buffered chunks, then the rest", async () => {
    const streams = memoryRedis();
    const id = crypto.randomUUID();
    const producer = channel();
    for (const n of [1, 2, 3]) producer.write(delta(n));
    const published = publishTurnStream(id, producer.stream, streams);
    await until(async () => (await hasTurnStream(id, streams)) === true);

    const follower = await resumeTurnStream(id, streams);
    expect(follower).toBeInstanceOf(ReadableStream);
    const followed = textOf(follower as ReadableStream<string>);
    producer.write(delta(4));
    producer.write(delta(5));
    producer.close();
    await published;

    expect(frames(await followed)).toEqual([1, 2, 3, 4, 5].map(delta));
  });

  it("resume is null once the producer finished, undefined for an unknown id", async () => {
    const streams = memoryRedis();
    const id = crypto.randomUUID();
    const producer = channel();
    producer.write(delta(1));
    producer.close();
    await publishTurnStream(id, producer.stream, streams);

    await until(async () => (await hasTurnStream(id, streams)) === "DONE");
    expect(await resumeTurnStream(id, streams)).toBeNull();
    expect(
      await resumeTurnStream(crypto.randomUUID(), streams)
    ).toBeUndefined();
    expect(await hasTurnStream(crypto.randomUUID(), streams)).toBeNull();
  });

  it("a failing publish, set or get is logged and resolves null; incr still rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = () => Promise.reject(new Error("OOM command not allowed"));
    const client = {
      publish: vi.fn(down),
      set: vi.fn(down),
      get: vi.fn(down),
      incr: vi.fn(down),
    };
    const publisher = loggingPublisher(
      client as unknown as Parameters<typeof loggingPublisher>[0]
    );
    await expect(publisher.publish("c", "m")).resolves.toBeNull();
    await expect(publisher.set("k", "v", { EX: 60 })).resolves.toBeNull();
    expect(client.set).toHaveBeenCalledWith("k", "v", "EX", 60);
    await expect(publisher.get("k")).resolves.toBeNull();
    await expect(publisher.incr("k")).rejects.toThrow("OOM");
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  it("dispatches messages by channel and logs a failing unsubscribe", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = ioredisLike({ unsubscribeFails: true });
    const subscriber = loggingSubscriber(client.subscriber);
    const a = vi.fn();
    const b = vi.fn();
    await subscriber.subscribe("a", a);
    await subscriber.subscribe("b", b);
    await client.publisher.publish("a", "to a");
    await client.publisher.publish("b", "to b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a).toHaveBeenCalledExactlyOnceWith("to a");
    expect(b).toHaveBeenCalledExactlyOnceWith("to b");
    await expect(subscriber.unsubscribe("a")).resolves.toBeNull();
    await subscriber.unsubscribe("b");
    expect(client.listeners()).toBe(0);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("Valkey errors at a stream's end and on reads never reject unhandled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const client = ioredisLike({ unsubscribeFails: true });
      const streams = createResumableStreamContext({
        waitUntil: null,
        publisher: loggingPublisher(client.publisher),
        subscriber: loggingSubscriber(client.subscriber),
      });
      const id = crypto.randomUUID();
      const producer = channel();
      producer.write(delta(1));
      producer.close();
      // The DONE branch unsubscribes: that rejection is logged.
      await publishTurnStream(id, producer.stream, streams);
      await until(async () => (await hasTurnStream(id, streams)) === "DONE");

      // Reads fail from now on: the stream reads as never published.
      client.failReads();
      expect(await hasTurnStream(id, streams)).toBeNull();
      expect(await resumeTurnStream(id, streams)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(
        error.mock.calls.some((args) => String(args[0]).includes("unsubscribe"))
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", unhandled);
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
