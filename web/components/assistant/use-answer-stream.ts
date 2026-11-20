import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import * as React from "react";
import type { AnswerMetadata } from "@/lib/assistant/turn-parts";
import { getAllowanceQuery, getConversationQuery } from "@/web/api/assistant";
import { AssistantChatTransport } from "@/web/api/assistant-transport";

/** While an answer runs but no stream is followed, its row is read this often. */
export const ANSWER_REFETCH_MS = 5_000;
/**
 * How long after a follow ended without its finish (a 204, a dropped
 * connection) the answer's stream is opened again: each wait in turn, then
 * the last one, for as long as the answer is pending.
 */
export const RESUME_RETRY_MS = [1_000, 2_000, 5_000, 10_000] as const;

type Settled = "done" | "failed" | null;

function statusOf(metadata: unknown): Settled {
  const status = (metadata as Partial<AnswerMetadata> | undefined)?.status;
  return status === "done" || status === "failed" ? status : null;
}

/**
 * Follows a chat's running answer (`pendingId`) over GET /answer-stream with
 * the AI SDK's `useChat`, and returns it as it streams (`live`: the chat's
 * message with that id while its stream delivers it, and once that stream
 * carried its finish; else null, and the stored row is shown).
 *
 * - At mount the chat's running answer, if any, is followed; each later new
 *   `pendingId` (a send, retry or edit) too.
 * - When the stream ends (its `finish` chunk, or an error) the conversation
 *   and the allowance are refetched and `onSettled` gets the finish's status
 *   (null without one).
 * - While `pendingId` is set and no stream delivers it (waiting for the
 *   first chunk, a 204, an error, a stream cut early, a finish whose row is
 *   not read yet), the conversation (and the allowance) is read every 5 s;
 *   a follow that ended without its finish is opened again after
 *   RESUME_RETRY_MS (the route replays the answer from its first chunk),
 *   until the answer is no longer pending.
 * - Once the answer is no longer pending (stopped, finished, deleted), the
 *   stream is no longer followed.
 *
 * Mount it with the conversation read: `pendingId` at mount is taken as the
 * answer the mount's follow is for.
 */
export function useAnswerStream(
  conversationId: string,
  pendingId: string | null,
  onSettled: (status: Settled) => void
): { live: UIMessage | null; stop: () => void } {
  const queryClient = useQueryClient();
  const [transport] = React.useState(() => new AssistantChatTransport());
  const onSettledRef = React.useRef(onSettled);
  const pendingRef = React.useRef(pendingId);
  React.useEffect(() => {
    onSettledRef.current = onSettled;
    pendingRef.current = pendingId;
  });
  // The answer's row (status, parts, sources) and the allowance it spent.
  const refetch = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getConversationQuery(conversationId).queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: getAllowanceQuery().queryKey,
    });
  }, [queryClient, conversationId]);
  // The answer whose stream carried its finish: shown live until its row
  // is read, and never followed again.
  const [finishedId, setFinishedId] = React.useState<string | null>(null);
  const settle = (status: Settled) => {
    if (status) setFinishedId(pendingRef.current);
    refetch();
    onSettledRef.current(status);
  };
  // The library's automatic resume is off: the follows (the mount's
  // included) are this hook's, so a reconnect never cuts one in flight.
  const { messages, status, resumeStream, stop } = useChat({
    id: conversationId,
    transport,
    onFinish: ({ message, isAbort, isError }) => {
      // An error is onError's; an abort is ours (stopped following).
      if (isAbort || isError) return;
      settle(statusOf(message.metadata));
    },
    onError: () => settle(null),
  });

  // A follow in flight (its request, then its stream), and a count of the
  // follows that ended, which schedules the next reconnect. Each follow
  // aborts the one before it (the SDK keeps one resume at a time): only the
  // latest one's end counts, else a superseded follow would schedule a
  // reconnect that aborts the live one, and so on.
  const inFlight = React.useRef(false);
  const latestFollow = React.useRef(0);
  const [ended, setEnded] = React.useState(0);
  const follow = React.useCallback(() => {
    const seq = ++latestFollow.current;
    inFlight.current = true;
    void resumeStream().finally(() => {
      if (latestFollow.current !== seq) return;
      inFlight.current = false;
      setEnded((n) => n + 1);
    });
  }, [resumeStream]);
  React.useEffect(follow, [follow]);

  const followed = React.useRef(pendingId);
  const attempts = React.useRef(0);
  React.useEffect(() => {
    if (pendingId === followed.current) return;
    followed.current = pendingId;
    attempts.current = 0;
    if (pendingId) follow();
    else void stop();
  }, [pendingId, follow, stop]);

  const streaming = status === "streaming";
  React.useEffect(() => {
    if (streaming) attempts.current = 0;
  }, [streaming]);
  const finished = pendingId !== null && finishedId === pendingId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ended` is the trigger
  React.useEffect(() => {
    if (!pendingId || finished || inFlight.current) return;
    const delay =
      RESUME_RETRY_MS[Math.min(attempts.current, RESUME_RETRY_MS.length - 1)];
    const timer = setTimeout(() => {
      attempts.current += 1;
      follow();
    }, delay);
    return () => clearTimeout(timer);
  }, [pendingId, finished, ended, follow]);

  // Also after a finish, until the row read says the answer ended.
  React.useEffect(() => {
    if (!pendingId || streaming) return;
    const timer = setInterval(refetch, ANSWER_REFETCH_MS);
    return () => clearInterval(timer);
  }, [pendingId, streaming, refetch]);

  const live =
    ((streaming || finished) &&
      pendingId &&
      messages.findLast((m) => m.id === pendingId && m.role === "assistant")) ||
    null;
  return { live, stop: () => void stop() };
}
