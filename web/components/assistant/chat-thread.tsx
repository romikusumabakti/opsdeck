import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { EmptyState } from "@/components/ui/empty-state";
import {
  type Conversation,
  type ConversationMessage,
  getAllowanceQuery,
  getConversationQuery,
} from "@/web/api/assistant";
import { MessageView } from "./message-view";
import { useMessageStream } from "./use-message-stream";

const isPending = (m: ConversationMessage) =>
  m.role === "assistant" && (m.status === "queued" || m.status === "streaming");

/** The conversation's unfinished answer, if any (at most one at a time). */
export function pendingAnswer(
  conversation: Conversation | undefined
): ConversationMessage | null {
  return conversation?.messages.findLast(isPending) ?? null;
}

/**
 * The messages of one conversation. The unfinished answer follows its SSE
 * stream; once it ends the conversation (sources, final status) and the
 * allowance are refetched.
 */
export function ChatThread({ conversationId }: { conversationId: string }) {
  const t = useTranslations("assistant");
  const queryClient = useQueryClient();
  const conversation = useQuery(getConversationQuery(conversationId)).data;
  const pending = pendingAnswer(conversation);

  const snapshot = useMessageStream(pending?.id ?? null, () => {
    queryClient.invalidateQueries({
      queryKey: getConversationQuery(conversationId).queryKey,
    });
    queryClient.invalidateQueries({ queryKey: getAllowanceQuery().queryKey });
  });

  const messages = (conversation?.messages ?? []).map((m) =>
    snapshot && m.id === pending?.id ? { ...m, ...snapshot } : m
  );

  // While an answer runs, keep its newest text in view.
  const endRef = React.useRef<HTMLDivElement>(null);
  const follow = pending
    ? `${pending.id}:${snapshot?.content.length ?? 0}`
    : null;
  React.useEffect(() => {
    if (follow) endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [follow]);

  if (conversation && messages.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title={t("emptyThreadTitle")}
        description={t("emptyThreadDescription")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {messages.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
