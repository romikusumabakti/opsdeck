import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import * as React from "react";
import type { AnswerMetadata } from "@/lib/assistant/turn-parts";
import { getAllowanceQuery, getConversationQuery } from "@/web/api/assistant";
import { AssistantChatTransport } from "@/web/api/assistant-transport";

/** While an answer runs but no stream is followed, its row is read this often. */
export const ANSWER_REFETCH_MS = 5_000;

type Settled = "done" | "failed" | null;

function statusOf(metadata: unknown): Settled {
  const status = (metadata as Partial<AnswerMetadata> | undefined)?.status;
  return status === "done" || status === "failed" ? status : null;
}

/**
 * Follows a chat's running answer (`pendingId`) over GET /answer-stream with
 * the AI SDK's `useChat`, and returns it as it streams (`live`: the chat's
 * message with that id; null until its first chunk).
 *
 * - At mount `resume: true` follows the answer running then, if any; each
 *   later new `pendingId` (a send, retry or edit) is followed once.
 * - When the stream ends (its `finish` chunk, or an error) the conversation
 *   and the allowance are refetched and `onSettled` gets the finish's status
 *   (null without one).
 * - While `pendingId` is set and no stream is followed (a 204, an error, a
 *   stream that ended early), the conversation (and the allowance) is read
 *   every 5 s until the answer is no longer pending.
 * - Once the answer is no longer pending (stopped, finished, deleted), the
 *   stream is no longer followed.
 *
 * Mount it with the conversation read: `pendingId` at mount is taken as the
 * answer the mount's resume follows.
 */
export function useAnswerStream(
  conversationId: string,
  pendingId: string | null,
  onSettled: (status: Settled) => void
): { live: UIMessage | null; stop: () => void } {
  const queryClient = useQueryClient();
  const [transport] = React.useState(() => new AssistantChatTransport());
  const onSettledRef = React.useRef(onSettled);
  React.useEffect(() => {
    onSettledRef.current = onSettled;
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
  const settle = (status: Settled) => {
    refetch();
    onSettledRef.current(status);
  };
  const { messages, status, resumeStream, stop } = useChat({
    id: conversationId,
    transport,
    resume: true,
    onFinish: ({ message, isAbort, isError }) => {
      // An error is onError's; an abort is ours (stopped following).
      if (isAbort || isError) return;
      settle(statusOf(message.metadata));
    },
    onError: () => settle(null),
  });

  const followed = React.useRef(pendingId);
  React.useEffect(() => {
    if (pendingId === followed.current) return;
    followed.current = pendingId;
    void (pendingId ? resumeStream() : stop());
  }, [pendingId, resumeStream, stop]);

  const following = status === "submitted" || status === "streaming";
  React.useEffect(() => {
    if (!pendingId || following) return;
    const timer = setInterval(refetch, ANSWER_REFETCH_MS);
    return () => clearInterval(timer);
  }, [pendingId, following, refetch]);

  const live =
    (pendingId &&
      messages.findLast((m) => m.id === pendingId && m.role === "assistant")) ||
    null;
  return { live, stop: () => void stop() };
}
