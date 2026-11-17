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
import { isNearBottom } from "./stick-to-bottom";
import { useMessageStream } from "./use-message-stream";

const isPending = (m: ConversationMessage) =>
  m.role === "assistant" && (m.status === "queued" || m.status === "streaming");

/** The question asked about the project branches (a project still there). */
function isProjectBranches(question: ConversationMessage | undefined) {
  return question?.context?.kind === "project" && !question.context.deleted;
}

/** The conversation's unfinished answer, if any (at most one at a time). */
export function pendingAnswer(
  conversation: Conversation | undefined
): ConversationMessage | null {
  return conversation?.messages.findLast(isPending) ?? null;
}

/**
 * The messages of one conversation in their own scroll area. The unfinished
 * answer follows its SSE stream; once it ends the conversation (sources,
 * final status) and the allowance are refetched.
 */
export function ChatThread({
  conversationId,
  projectName,
}: {
  conversationId: string;
  projectName?: string;
}) {
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

  // Follow new content only while the reader is at the end; scrolling up to
  // an older answer stops it until they scroll back down. The caller's own
  // question always brings the end back into view.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const stuck = React.useRef(true);
  const last = messages.at(-1);
  const lastQuestionId = messages.findLast((m) => m.role === "user")?.id;
  const contentKey = `${messages.length}:${last?.status}:${last?.content.length ?? 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new question is the trigger
  React.useLayoutEffect(() => {
    stuck.current = true;
  }, [lastQuestionId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey is the trigger
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [contentKey]);
  // Markdown, code blocks and sources can grow after the text arrives.
  const observeList = React.useCallback((list: HTMLDivElement) => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const el = scrollerRef.current;
      if (el && stuck.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollerRef}
      onScroll={(e) => {
        stuck.current = isNearBottom(e.currentTarget);
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {conversation && messages.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={t("emptyThreadTitle")}
          description={t("emptyThreadDescription")}
        />
      ) : (
        <div ref={observeList} className="flex flex-col gap-6">
          {messages.map((message, index) => (
            <MessageView
              key={message.id}
              message={message}
              projectName={projectName}
              projectBranches={isProjectBranches(
                messages.slice(0, index).findLast((m) => m.role === "user")
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
