import { JsonToSseTransformStream, type UIMessageChunk } from "ai";
import type IORedis from "ioredis";
import {
  createResumableStreamContext,
  type Publisher,
  type ResumableStreamContext,
  type Subscriber,
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

const logged = (command: string) => (error: unknown) => {
  console.error(`[assistant] turn stream ${command} failed`, error);
  return null;
};

/**
 * The library's publisher over an ioredis client, except that PUBLISH, SET
 * and GET failures are logged and resolve null: resumable-stream issues them
 * inside promise chains and timers it never handles (each chunk's publish,
 * the DONE sentinel, the resume ack timer), and an unhandled rejection exits
 * the Bun process, every running turn with it. A lost publish or sentinel
 * only costs followers the live view; a failed GET reads as "no stream"
 * (hasExistingStream null, resumeExistingStream undefined).
 */
export function loggingPublisher(
  client: Pick<IORedis, "publish" | "set" | "get" | "incr">
): Publisher {
  return {
    connect: async () => {},
    publish: (channel, message) =>
      client.publish(channel, message).catch(logged("publish")),
    set: (key, value, options) =>
      (options?.EX
        ? client.set(key, value, "EX", options.EX)
        : client.set(key, value)
      ).catch(logged("set")),
    get: (key) => client.get(key).catch(logged("get")),
    incr: (key) => client.incr(key),
  };
}

/**
 * The library's subscriber over an ioredis client (the shape of its own
 * ioredis adapter: one "message" listener dispatching by channel), except
 * that UNSUBSCRIBE failures are logged and resolve: the library unsubscribes
 * at every stream's end in chains it never handles. A callback that throws
 * or rejects is logged. SUBSCRIBE still rejects, where the library awaits it.
 */
export function loggingSubscriber(
  client: Pick<IORedis, "on" | "removeListener" | "subscribe" | "unsubscribe">
): Subscriber {
  const handlers = new Map<string, (message: string) => void>();
  // The library's callbacks run in an ioredis event: a throw or a rejection
  // there would be unhandled.
  const dispatch = (channel: string, message: string) => {
    try {
      const handled: unknown = handlers.get(channel)?.(message);
      if (handled instanceof Promise) handled.catch(logged("message"));
    } catch (error) {
      logged("message")(error);
    }
  };
  return {
    connect: async () => {},
    subscribe: async (channel, callback) => {
      if (handlers.size === 0) client.on("message", dispatch);
      handlers.set(channel, callback);
      await client.subscribe(channel);
    },
    unsubscribe: (channel) => {
      handlers.delete(channel);
      if (handlers.size === 0) client.removeListener("message", dispatch);
      return client.unsubscribe(channel).catch(logged("unsubscribe"));
    },
  };
}

/**
 * The process's stream context, created on first use with its own publisher
 * and subscriber connections (a subscribed connection cannot run other
 * commands). waitUntil is null: the worker and server are long-lived.
 */
export function turnStreamContext(): ResumableStreamContext {
  context ??= createResumableStreamContext({
    keyPrefix: TURN_STREAM_KEY_PREFIX,
    waitUntil: null,
    publisher: loggingPublisher(createRedisConnection()),
    subscriber: loggingSubscriber(createRedisConnection()),
  });
  return context;
}

/**
 * `stream`, closed (the error logged) instead of erroring: the library reads
 * the stream it publishes in a promise chain it never handles, where an
 * error would be an unhandled rejection. Followers of a stream cut short
 * read the row for its end.
 */
function closedOnError(
  messageId: string,
  stream: ReadableStream<string>
): ReadableStream<string> {
  const reader = stream.getReader();
  return new ReadableStream<string>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        console.error(
          `[assistant] the stream of ${messageId} failed; closed early`,
          error
        );
        controller.close();
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/**
 * Publishes one turn's UI message chunks as SSE text under `messageId`, and
 * drains it (the worker has no HTTP reader). Resolves once the chunks end
 * (or fail to serialize: the stream then ends early); a rejection is the
 * caller's to log.
 */
export async function publishTurnStream(
  messageId: string,
  chunks: ReadableStream<UIMessageChunk>,
  streams: ResumableStreamContext = turnStreamContext()
): Promise<void> {
  const sse = closedOnError(
    messageId,
    chunks.pipeThrough(new JsonToSseTransformStream())
  );
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
