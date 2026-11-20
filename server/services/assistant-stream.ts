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
 * A queued answer's wait for its stream, bounded like the run streams: the
 * client reconnects, which also frees sockets held by vanished tabs.
 */
export const STREAM_MAX_DURATION_MS = 10 * 60 * 1000;
/** How often a queued answer looks for its stream. */
export const STREAM_CHECK_MS = 250;
/** How often a queued answer re-reads its row (stopped, deleted). */
export const STATUS_CHECK_MS = 2000;
/** An SSE comment while waiting, so proxies keep the socket open. */
export const KEEPALIVE_MS = 15_000;
const KEEPALIVE = ": waiting\n\n";

export type AnswerStreamDeps = {
  resume?: typeof resumeTurnStream;
  has?: typeof hasTurnStream;
  now?: () => number;
  /** How long a queued answer is waited for (default 10 min). */
  waitMs?: number;
};

const pending = (status: AnswerState["status"]) =>
  status === "queued" || status === "streaming";

/** One UI message chunk as an SSE frame, as JsonToSseTransformStream writes. */
const frame = (chunk: UIMessageChunk) => `data: ${JSON.stringify(chunk)}\n\n`;

/**
 * The live UI message stream (SSE text) of the caller's chat's latest answer,
 * from its first chunk; null when there is none to follow (the route's 204):
 * no answer, one that ended, or a streaming one whose stream is gone (Valkey
 * lost it: the client reads the row instead). A queued answer gets a stream
 * that waits for the worker to publish its turn, then pipes it; ended before
 * that (stopped, or failed at start) it closes with the row's finish chunk.
 * Another user's or an unknown chat: 404.
 */
export async function openAnswerStream(
  conversationId: string,
  deps: AnswerStreamDeps = {}
): Promise<ReadableStream<string> | null> {
  const { conversation } = await ownConversation(conversationId);
  const answer = await findLatestAnswer(conversation.id);
  if (!answer || !pending(answer.status)) return null;
  const resume = deps.resume ?? resumeTurnStream;
  if (answer.status === "streaming") {
    try {
      return (await resume(answer.id)) ?? null;
    } catch (error) {
      console.error(`[assistant] could not resume ${answer.id}`, error);
      return null;
    }
  }
  return awaitTurnStream(answer.id, {
    resume,
    has: deps.has ?? hasTurnStream,
    now: deps.now ?? Date.now,
    waitMs: deps.waitMs ?? STREAM_MAX_DURATION_MS,
  });
}

/**
 * Waits for a queued answer's stream: checks for it every STREAM_CHECK_MS
 * and the row every STATUS_CHECK_MS, with a keepalive comment every
 * KEEPALIVE_MS. The only polling left, and only while a turn is queued.
 */
function awaitTurnStream(
  messageId: string,
  deps: Required<AnswerStreamDeps>
): ReadableStream<string> {
  let cancelled = false;
  let followed: ReadableStreamDefaultReader<string> | undefined;
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
      const follow = async (stream: ReadableStream<string>) => {
        followed = stream.getReader();
        for (;;) {
          const { done, value } = await followed.read();
          if (done || cancelled) return;
          send(value);
        }
      };
      const run = async () => {
        const started = deps.now();
        let pinged = started;
        let checked = started;
        while (!cancelled) {
          const published = await deps.has(messageId);
          if (published === true) {
            const stream = await deps.resume(messageId);
            if (stream) await follow(stream);
            return;
          }
          const at = deps.now();
          // A finished stream ("DONE") means the row has ended too.
          if (published === "DONE" || at - checked >= STATUS_CHECK_MS) {
            checked = at;
            const row = await readAnswerStatus(messageId);
            if (!row) return;
            if (!pending(row.status)) {
              const metadata: AnswerMetadata = {
                status: row.status === "done" ? "done" : "failed",
                errorCode: row.errorCode,
              };
              send(frame({ type: "finish", messageMetadata: metadata }));
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
            `[assistant] stopped waiting for the stream of ${messageId}`,
            error
          );
        })
        .finally(end);
    },
    async cancel() {
      cancelled = true;
      await followed?.cancel();
    },
  });
}
