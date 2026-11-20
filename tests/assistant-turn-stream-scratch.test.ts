import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

// The turn stream against a real Valkey through createRedisConnection() (the
// ioredis clients the worker uses), proving resumable-stream accepts them.
// Keys are per-run message ids under the menara-assistant-stream prefix and
// expire on their own (24 h). Point REDIS_URL at a local Valkey, e.g.:
//
//   podman start menara-e2e-valkey
//   ASSISTANT_SCRATCH_VALKEY=1 REDIS_URL=redis://127.0.0.1:6379 bun --bun vitest run --maxWorkers=2 tests/assistant-turn-stream-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_VALKEY === "1";

const delta = (n: number): UIMessageChunk => ({
  type: "text-delta",
  id: "t1",
  delta: `part ${n} `,
});

function frames(sse: string): unknown[] {
  return sse
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
}

describe.skipIf(!enabled)("turn stream on a real Valkey", () => {
  it("a follower that joins mid-stream gets the buffered chunks, then the rest", async () => {
    const { hasTurnStream, publishTurnStream, resumeTurnStream } = await import(
      "@/lib/assistant/turn-stream"
    );
    const id = crypto.randomUUID();
    let controller!: ReadableStreamDefaultController<UIMessageChunk>;
    const chunks = new ReadableStream<UIMessageChunk>({
      start(c) {
        controller = c;
      },
    });
    for (const n of [1, 2, 3]) controller.enqueue(delta(n));
    const published = publishTurnStream(id, chunks);
    for (let i = 0; (await hasTurnStream(id)) !== true; i++) {
      if (i > 200) throw new Error("the stream was never published");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const follower = await resumeTurnStream(id);
    if (!follower) throw new Error(`expected a stream, got ${follower}`);
    const followed = (async () => {
      let text = "";
      const reader = follower.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += value;
      }
    })();
    controller.enqueue(delta(4));
    controller.enqueue(delta(5));
    controller.close();
    await published;

    expect(frames(await followed)).toEqual([1, 2, 3, 4, 5].map(delta));
    expect(await hasTurnStream(id)).toBe("DONE");
    expect(await resumeTurnStream(id)).toBeNull();
    expect(await resumeTurnStream(crypto.randomUUID())).toBeUndefined();
  });
});
