import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import * as React from "react";
import type { AssistantPart } from "@/lib/assistant/turn-parts";
import {
  type Conversation,
  type ConversationMessage,
  getConversationQuery,
} from "@/web/api/assistant";
import { MessageView, type ShownMessage } from "./message-view";
import { isNearBottom } from "./stick-to-bottom";
import { refreshTitleAfterFirstAnswer } from "./title-refresh";
import { useAnswerStream } from "./use-answer-stream";

const isPending = (m: ConversationMessage) =>
  m.role === "assistant" && (m.status === "queued" || m.status === "streaming");

const ASSISTANT_PART_TYPES = new Set(["step-start", "text", "dynamic-tool"]);

/** The parts an answer is made of (a live message carries no others). */
const isAssistantPart = (
  part: UIMessage["parts"][number]
): part is UIMessage["parts"][number] & AssistantPart =>
  ASSISTANT_PART_TYPES.has(part.type);

/**
 * The question read project branches: a pinned project still there, or an
 * automatic question (it reads the branches of the projects it opens).
 */
function isProjectBranches(question: ShownMessage | undefined) {
  const context = question?.context;
  return (
    context?.kind === "auto" ||
    (context?.kind === "project" && !context.deleted)
  );
}

/** The conversation's unfinished answer, if any (at most one at a time). */
export function pendingAnswer(
  conversation: Conversation | undefined
): ConversationMessage | null {
  return conversation?.messages.findLast(isPending) ?? null;
}

type ThreadProps = {
  conversationId: string;
  /** Asks the last answer again (offered on that answer only). */
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** Resends the last question with new text (offered on it only). */
  onEditLast?: (text: string) => Promise<void>;
  editDisabled?: boolean;
};

/** The text a message shows so far, to follow it while it grows. */
function shownLength(message: ShownMessage | undefined): number {
  if (!message?.parts) return message?.content.length ?? 0;
  let length = message.parts.length;
  for (const part of message.parts) {
    if (part.type === "text") length += part.text.length;
  }
  return length;
}

/**
 * The messages of one conversation in their own scroll area, once it is
 * read. The unfinished answer is followed over its stream
 * (`useAnswerStream`) and shown from the live parts; once it ends the
 * conversation (sources, final status) and the allowance are refetched. A
 * chat's first answer done also gets an auto title, written after the
 * stream closed: the chat list is read again until it shows
 * (`refreshTitleAfterFirstAnswer`).
 */
export function ChatThread(props: ThreadProps) {
  const conversation = useQuery(
    getConversationQuery(props.conversationId)
  ).data;
  if (!conversation) return <div className="min-h-0 flex-1" />;
  return <LoadedThread {...props} conversation={conversation} />;
}

function LoadedThread({
  conversationId,
  conversation,
  onRetry,
  retryDisabled,
  onEditLast,
  editDisabled,
}: ThreadProps & { conversation: Conversation }) {
  const queryClient = useQueryClient();
  const pending = pendingAnswer(conversation);
  const conversationRef = React.useRef(conversation);
  React.useEffect(() => {
    conversationRef.current = conversation;
  });

  const { live } = useAnswerStream(
    conversationId,
    pending?.id ?? null,
    (status) => {
      const read = conversationRef.current;
      if (
        status === "done" &&
        !read.temporary &&
        read.messages.filter((m) => m.role === "user").length === 1
      ) {
        refreshTitleAfterFirstAnswer(queryClient, conversationId, read.title);
      }
    }
  );
  const liveParts = live?.parts.filter(isAssistantPart);

  const messages: ShownMessage[] = conversation.messages.map((m) =>
    liveParts && m.id === pending?.id
      ? {
          ...m,
          parts: liveParts,
          status: m.status === "queued" ? ("streaming" as const) : m.status,
        }
      : m
  );

  // Follow new content only while the reader is at the end; scrolling up to
  // an older answer stops it until they scroll back down. The caller's own
  // question always brings the end back into view.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const stuck = React.useRef(true);
  const last = messages.at(-1);
  const lastQuestionId = messages.findLast((m) => m.role === "user")?.id;
  const contentKey = `${messages.length}:${last?.status}:${shownLength(last)}`;
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
      <div
        ref={observeList}
        className="mx-auto flex w-full max-w-3xl flex-col gap-6"
      >
        {messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            isLast={index === messages.length - 1}
            onRetry={index === messages.length - 1 ? onRetry : undefined}
            retryDisabled={retryDisabled}
            onEdit={message.id === lastQuestionId ? onEditLast : undefined}
            editDisabled={editDisabled}
            projectBranches={isProjectBranches(
              messages.slice(0, index).findLast((m) => m.role === "user")
            )}
          />
        ))}
      </div>
    </div>
  );
}
