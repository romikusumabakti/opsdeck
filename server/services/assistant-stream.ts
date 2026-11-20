import type { UIMessageChunk } from "ai";
import {
  type AnswerState,
  findLatestAnswer,
  readAnswerStatus,
} from "@/lib/assistant/conversation-store";
import type { AnswerMetadata } from "@/lib/assistant/turn-parts";
import { hasTurnStream, resumeTurnStream } from "@/lib/assistant/turn-stream";
import { ownConversation } from "@/server/services/assistant";

/**
 * How long an answer stream stays open (the queued wait included), like the
 * run streams: the client reconnects, which also frees sockets held by
 * vanished tabs.
 */
export const STREAM_MAX_DURATION_MS = 10 * 60 * 1000;
/** How often a queued answer looks for its stream. */
export const STREAM_CHECK_MS = 250;
/** How often a waiting answer re-reads its row (stopped, deleted). */
export const STATUS_CHECK_MS = 2000;
/** An SSE comment while waiting, so proxies keep the socket open. */
export const KEEPALIVE_MS = 15_000;
/**
 * A resume waits this long for the producer's ack: one whose producer died
 * (or whose Valkey hangs) is given up, as if there were no stream.
 */
export const RESUME_TIMEOUT_MS = 3000;
const KEEPALIVE = ": waiting\n\n";
/**
 * A finish chunk's frame. Unambiguous in the SSE text: inside a JSON string
 * (a text delta) the quotes are escaped.
 */
const FINISH_MARK = '"type":"finish"';

export type AnswerStreamDeps = {
  resume?: typeof resumeTurnStream;
  has?: typeof hasTurnStream;
  now?: () => number;
  /** How long a queued answer is waited for (default 10 min). */
  waitMs?: number;
  /** How long a resume may take (default RESUME_TIMEOUT_MS). */
  resumeTimeoutMs?: number;
};

const pending = (status: AnswerState["status"]) =>
  status === "queued" || status === "streaming";

/** One UI message chunk as an SSE frame, as JsonToSseTransformStream writes. */
const frame = (chunk: UIMessageChunk) => `data: ${JSON.stringify(chunk)}\n\n`;

const finishFrame = (metadata: AnswerMetadata) =>
  frame({ type: "finish", messageMetadata: metadata });

/**
 * The answer's stream, or null when it is gone, failed to resume, or did not
 * answer within `timeoutMs`; a stream resumed after that is cancelled, which
 * frees its listener.
 */
async function resumeWithin(
  resume: typeof resumeTurnStream,
  messageId: string,
  timeoutMs: number
): Promise<ReadableStream<string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resumed = Promise.resolve().then(() => resume(messageId));
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([resumed, timedOut]);
    if (result !== "timeout") return result ?? null;
    console.warn(`[assistant] resuming ${messageId} timed out`);
    resumed.then(
      (late) => late?.cancel().catch(() => {}),
      () => {}
    );
    return null;
  } catch (error) {
    console.error(`[assistant] could not resume ${messageId}`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The live UI message stream (SSE text) of the caller's chat's latest answer,
 * from its first chunk; null when there is none to follow (the route's 204):
 * no answer, one that ended, or a streaming one whose stream is gone (Valkey
 * lost it: the client reads the row instead). A queued answer gets a stream
 * that waits for the worker to publish its turn, then pipes it. Every stream
 * returned ends with a finish chunk: the turn's own, or one from the row
 * when the turn's stream ended without it (or never came).
 * Another user's or an unknown chat: 404.
 */
export async function openAnswerStream(
  conversationId: string,
  deps: AnswerStreamDeps = {}
): Promise<ReadableStream<string> | null> {
  const { conversation } = await ownConversation(conversationId);
  const answer = await findLatestAnswer(conversation.id);
  if (!answer || !pending(answer.status)) return null;
  const resolved: Required<AnswerStreamDeps> = {
    resume: deps.resume ?? resumeTurnStream,
    has: deps.has ?? hasTurnStream,
    now: deps.now ?? Date.now,
    waitMs: deps.waitMs ?? STREAM_MAX_DURATION_MS,
    resumeTimeoutMs: deps.resumeTimeoutMs ?? RESUME_TIMEOUT_MS,
  };
  if (answer.status === "queued") return followAnswer(answer.id, resolved);
  const stream = await resumeWithin(
    resolved.resume,
    answer.id,
    resolved.resumeTimeoutMs
  );
  return stream ? followAnswer(answer.id, resolved, stream) : null;
}

/**
 * Follows an answer's stream (`initial`, or the one a queued answer's worker
 * publishes: looked for every STREAM_CHECK_MS) and makes sure it ends with a
 * finish: when the stream ended without one, or never came, the row is read
 * every STATUS_CHECK_MS until it ends, and its finish is written (a deleted
 * chat's as stopped). A keepalive comment goes out every KEEPALIVE_MS while
 * waiting; the wait gives up after `waitMs`. The only polling left, and only
 * while a turn is queued or its stream is lost.
 */
function followAnswer(
  messageId: string,
  deps: Required<AnswerStreamDeps>,
  initial?: ReadableStream<string>
): ReadableStream<string> {
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<string> | undefined;
  return new ReadableStream<string>({
    start(controller) {
      const send = (text: string) => {
        if (!cancelled) controller.enqueue(text);
      };
      const end = () => {
        try {
          controller.close();
        } catch {
          // Already closed: the reader went away.
        }
      };
      /** Pipes `stream`; true when it carried the finish. */
      const follow = async (stream: ReadableStream<string>) => {
        reader = stream.getReader();
        let finished = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) {
            await reader.cancel().catch(() => {});
            return true;
          }
          if (done) return finished;
          if (value.includes(FINISH_MARK)) finished = true;
          send(value);
        }
      };
      const run = async () => {
        const started = deps.now();
        let pinged = started;
        let checked = started;
        // A turn's stream is followed once: a second resume would replay it.
        let followed = false;
        let checkNow = false;
        if (initial) {
          followed = true;
          if (await follow(initial)) return;
          checkNow = true;
        }
        while (!cancelled) {
          if (!followed) {
            const published = await deps.has(messageId);
            if (published === true) {
              followed = true;
              const stream = await resumeWithin(
                deps.resume,
                messageId,
                deps.resumeTimeoutMs
              );
              if (cancelled) {
                await stream?.cancel().catch(() => {});
                return;
              }
              if (stream && (await follow(stream))) return;
              checkNow = true;
            } else if (published === "DONE") {
              // Finished: the row has ended too.
              checkNow = true;
            }
          }
          if (cancelled) return;
          const at = deps.now();
          if (checkNow || at - checked >= STATUS_CHECK_MS) {
            checkNow = false;
            checked = at;
            const row = await readAnswerStatus(messageId);
            if (!row) {
              // Deleted with its chat: told like a stopped answer.
              send(
                finishFrame({
                  status: "failed",
                  errorCode: "assistant.stopped",
                })
              );
              return;
            }
            if (!pending(row.status)) {
              send(
                finishFrame({
                  status: row.status === "done" ? "done" : "failed",
                  errorCode: row.errorCode,
                })
              );
              return;
            }
          }
          if (at - started >= deps.waitMs) return;
          if (at - pinged >= KEEPALIVE_MS) {
            pinged = at;
            send(KEEPALIVE);
          }
          await new Promise((resolve) => setTimeout(resolve, STREAM_CHECK_MS));
        }
      };
      run()
        .catch((error) => {
          console.error(
            `[assistant] stopped following the stream of ${messageId}`,
            error
          );
        })
        .finally(end);
    },
    async cancel() {
      cancelled = true;
      await reader?.cancel().catch(() => {});
    },
  });
}
