import { JsonToSseTransformStream, type UIMessageChunk } from "ai";
import type IORedis from "ioredis";
import {
  createResumableStreamContext,
  type Publisher,
  type ResumableStreamContext,
} from "resumable-stream/ioredis";
import { createRedisConnection } from "@/lib/queue";

/**
 * The resumable UI message stream of an assistant answer on Valkey, keyed by
 * its message id (the row's active_stream_id). The worker publishes each turn
 * (publishTurnStream); the answer-stream route resumes it for any tab, from
 * its first chunk. Postgres keeps the durable copy: a stream lost with Valkey
 * only costs the live view.
 */
export const TURN_STREAM_KEY_PREFIX = "menara-assistant-stream";

let context: ResumableStreamContext | undefined;

/**
 * The library's publisher over an ioredis client, except that PUBLISH and
 * SET failures are logged and resolve: resumable-stream issues both inside
 * promise chains it never handles (each chunk's publish, the DONE sentinel),
 * and an unhandled rejection exits the Bun process, every running turn with
 * it. A lost publish or sentinel only costs followers the live view.
 */
export function loggingPublisher(
  client: Pick<IORedis, "publish" | "set" | "get" | "incr">
): Publisher {
  const logged = (command: string) => (error: unknown) => {
    console.error(`[assistant] turn stream ${command} failed`, error);
    return null;
  };
  return {
    connect: async () => {},
    publish: (channel, message) =>
      client.publish(channel, message).catch(logged("publish")),
    set: (key, value, options) =>
      (options?.EX
        ? client.set(key, value, "EX", options.EX)
        : client.set(key, value)
      ).catch(logged("set")),
    get: (key) => client.get(key),
    incr: (key) => client.incr(key),
  };
}

/**
 * The process's stream context, created on first use with its own publisher
 * and subscriber connections (a subscribed connection cannot run other
 * commands); the library adapts the ioredis subscriber itself. waitUntil is
 * null: the worker and server are long-lived.
 */
export function turnStreamContext(): ResumableStreamContext {
  context ??= createResumableStreamContext({
    keyPrefix: TURN_STREAM_KEY_PREFIX,
    waitUntil: null,
    publisher: loggingPublisher(createRedisConnection()),
    subscriber: createRedisConnection(),
  });
  return context;
}

/**
 * Publishes one turn's UI message chunks as SSE text under `messageId`, and
 * drains it (the worker has no HTTP reader). Resolves once the chunks end;
 * a rejection is the caller's to log.
 */
export async function publishTurnStream(
  messageId: string,
  chunks: ReadableStream<UIMessageChunk>,
  streams: ResumableStreamContext = turnStreamContext()
): Promise<void> {
  const sse = chunks.pipeThrough(new JsonToSseTransformStream());
  const published = await streams.createNewResumableStream(
    messageId,
    () => sse
  );
  if (!published) return;
  const reader = published.getReader();
  while (!(await reader.read()).done) {
    // Followers get the chunks over pub/sub; nothing to do here.
  }
}

/**
 * The answer's stream from its first chunk: null once it finished,
 * undefined when it was never published (or has expired).
 */
export function resumeTurnStream(
  messageId: string,
  streams: ResumableStreamContext = turnStreamContext()
): Promise<ReadableStream<string> | null | undefined> {
  return streams.resumeExistingStream(messageId);
}

/** Whether the answer's stream was published: true, "DONE", or null. */
export function hasTurnStream(
  messageId: string,
  streams: ResumableStreamContext = turnStreamContext()
): Promise<null | true | "DONE"> {
  return streams.hasExistingStream(messageId);
}
