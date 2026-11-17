import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assistantConversations,
  assistantDrafts,
  assistantMessages,
  assistantToolCalls,
  instanceSettings,
  issues,
  jiraProjectLinks,
} from "@/lib/db/schema";
import type { AssistantSource } from "./sources";

/**
 * The Postgres side of the assistant API (server/services/assistant.ts):
 * conversations, the two rows a sent message creates, and the reads the chat
 * and its stream show. No authorization here; the service checks the caller
 * before calling any of it.
 */

export type MessageStatus = "queued" | "streaming" | "done" | "failed";

/** The longest conversation title, taken from the first message. */
export const TITLE_MAX_CHARS = 80;

/** First TITLE_MAX_CHARS characters (code points) of `text`, on one line. */
export function titleFrom(text: string): string {
  return Array.from(text.trim().replace(/\s+/g, " "))
    .slice(0, TITLE_MAX_CHARS)
    .join("");
}

/** The admin switch and cap, without decrypting the key. */
export async function loadAssistantLimits(): Promise<{
  enabled: boolean;
  hasApiKey: boolean;
  dailyCapUsd: number;
}> {
  const [row] = await db
    .select({
      enabled: instanceSettings.assistantEnabled,
      apiKey: instanceSettings.assistantApiKey,
      dailyCapUsd: instanceSettings.assistantDailyCapUsd,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return {
    enabled: row?.enabled ?? false,
    hasApiKey: !!row?.apiKey,
    dailyCapUsd: Number(row?.dailyCapUsd ?? 0),
  };
}

/** The environment, if it exists and belongs to the project. */
export async function environmentOfProject(
  environmentId: string,
  projectId: string
): Promise<{ id: string; name: string } | null> {
  const env = await db.query.environments.findFirst({
    where: { id: environmentId, projectId },
    columns: { id: true, name: true },
  });
  return env ?? null;
}

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: Date;
};

/** The user's conversations about one project, newest first. */
export async function listConversationsOf(
  userId: string,
  projectId: string
): Promise<ConversationSummary[]> {
  return db
    .select({
      id: assistantConversations.id,
      title: assistantConversations.title,
      updatedAt: assistantConversations.updatedAt,
    })
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.userId, userId),
        eq(assistantConversations.projectId, projectId)
      )
    )
    .orderBy(desc(assistantConversations.updatedAt));
}

/**
 * A project conversation. Its environment fields stay null: the source is
 * chosen per question (insertTurn).
 */
export async function insertConversation(values: {
  userId: string;
  projectId: string;
}): Promise<string> {
  const [row] = await db
    .insert(assistantConversations)
    .values(values)
    .returning({ id: assistantConversations.id });
  if (!row) throw new Error("conversation insert returned no row");
  return row.id;
}

export type ConversationOwner = {
  id: string;
  userId: string;
  projectId: string;
};

export async function findConversation(
  conversationId: string
): Promise<ConversationOwner | null> {
  const [row] = await db
    .select({
      id: assistantConversations.id,
      userId: assistantConversations.userId,
      projectId: assistantConversations.projectId,
    })
    .from(assistantConversations)
    .where(eq(assistantConversations.id, conversationId))
    .limit(1);
  return row ?? null;
}

/** The conversation an assistant message belongs to. */
export async function findAssistantMessageConversation(
  messageId: string
): Promise<ConversationOwner | null> {
  const [row] = await db
    .select({
      id: assistantConversations.id,
      userId: assistantConversations.userId,
      projectId: assistantConversations.projectId,
    })
    .from(assistantMessages)
    .innerJoin(
      assistantConversations,
      eq(assistantConversations.id, assistantMessages.conversationId)
    )
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.role, "assistant")
      )
    )
    .limit(1);
  return row ?? null;
}

export type ToolCallMeta = { tool: string; meta: Record<string, unknown> };

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  sources: AssistantSource[] | null;
  attachmentIds: string[];
  /**
   * User messages: the environment the question asked about; both null for
   * the project branches. Once that environment is deleted the id is null,
   * the name snapshot stays and environmentDeleted is true. Always null and
   * false on assistant messages.
   */
  environmentId: string | null;
  environmentName: string | null;
  environmentDeleted: boolean;
  createdAt: Date;
  /** Assistant messages only; result metadata, never the tool input. */
  toolCalls: ToolCallMeta[];
};

export type ConversationDraft = {
  id: string;
  kind: "brd" | "jira";
  content: Record<string, unknown>;
  issueId: string | null;
  /** The created issue's Jira key; null before creation or once unlinked. */
  jiraKey: string | null;
  /** The created Panel issue's number (`/<KEY>/issues/<n>`); null before. */
  issueNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationDetail = {
  id: string;
  /** Its project: a page checks a conversation link against its own. */
  projectId: string;
  title: string;
  messages: ConversationMessage[];
  drafts: ConversationDraft[];
  /** The project's Jira link is on and may write: a Jira draft can be created. */
  jiraPushEnabled: boolean;
};

async function toolCallsByMessage(
  messageIds: string[]
): Promise<Map<string, ToolCallMeta[]>> {
  const byMessage = new Map<string, ToolCallMeta[]>();
  if (messageIds.length === 0) return byMessage;
  const calls = await db
    .select({
      messageId: assistantToolCalls.messageId,
      tool: assistantToolCalls.tool,
      meta: assistantToolCalls.resultMeta,
    })
    .from(assistantToolCalls)
    .where(inArray(assistantToolCalls.messageId, messageIds))
    .orderBy(asc(assistantToolCalls.id));
  for (const call of calls) {
    const list = byMessage.get(call.messageId) ?? [];
    list.push({ tool: call.tool, meta: call.meta });
    byMessage.set(call.messageId, list);
  }
  return byMessage;
}

export async function loadConversationDetail(
  conversationId: string
): Promise<ConversationDetail | null> {
  const [conversation] = await db
    .select({
      id: assistantConversations.id,
      title: assistantConversations.title,
      projectId: assistantConversations.projectId,
    })
    .from(assistantConversations)
    .where(eq(assistantConversations.id, conversationId))
    .limit(1);
  if (!conversation) return null;
  const { projectId } = conversation;

  const [messages, drafts, [link]] = await Promise.all([
    db
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        content: assistantMessages.content,
        status: assistantMessages.status,
        errorCode: assistantMessages.errorCode,
        sources: assistantMessages.sources,
        attachmentIds: assistantMessages.attachmentIds,
        environmentId: assistantMessages.environmentId,
        environmentName: assistantMessages.environmentName,
        createdAt: assistantMessages.createdAt,
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      // uuidv7 ids sort by creation, also within one transaction.
      .orderBy(asc(assistantMessages.id)),
    db
      .select({
        id: assistantDrafts.id,
        kind: assistantDrafts.kind,
        content: assistantDrafts.content,
        issueId: assistantDrafts.issueId,
        jiraKey: issues.jiraKey,
        issueNumber: issues.number,
        createdAt: assistantDrafts.createdAt,
        updatedAt: assistantDrafts.updatedAt,
      })
      .from(assistantDrafts)
      .leftJoin(issues, eq(issues.id, assistantDrafts.issueId))
      .where(eq(assistantDrafts.conversationId, conversationId))
      .orderBy(asc(assistantDrafts.id)),
    db
      .select({
        enabled: jiraProjectLinks.enabled,
        pushEnabled: jiraProjectLinks.pushEnabled,
      })
      .from(jiraProjectLinks)
      .where(eq(jiraProjectLinks.projectId, projectId))
      .limit(1),
  ]);
  const calls = await toolCallsByMessage(
    messages.filter((m) => m.role === "assistant").map((m) => m.id)
  );
  return {
    ...conversation,
    messages: messages.map((m) => ({
      ...m,
      environmentDeleted:
        m.environmentId === null && m.environmentName !== null,
      toolCalls: calls.get(m.id) ?? [],
    })),
    drafts,
    jiraPushEnabled: !!(link?.enabled && link.pushEnabled),
  };
}

/** The FK error of a user message naming an environment that is gone. */
function isMissingEnvironment(error: unknown): boolean {
  const e = error as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  };
  const pg = e?.cause?.code ? e.cause : e;
  return (
    pg?.code === "23503" &&
    pg.constraint_name ===
      "assistant_messages_environment_id_environments_id_fk"
  );
}

export type CreatedTurn = { userMessageId: string; assistantMessageId: string };

/**
 * In one transaction: the user message (done) with the source it asks about
 * (`environment`, null for the project branches) and the assistant message
 * (queued) that answers it, the title from the first message, and the
 * conversation's updated_at. "busy" (nothing written) when an assistant
 * message of the conversation is still queued or streaming. The conversation
 * row is locked first, so two sends at once cannot both pass that check.
 * "environment_gone" (nothing written) when the asked-about environment was
 * deleted after the caller's check: the message's foreign key refuses it.
 */
export async function insertTurn(params: {
  conversationId: string;
  text: string;
  attachmentIds: string[];
  environment: { id: string; name: string } | null;
  now?: Date;
}): Promise<CreatedTurn | "busy" | "environment_gone"> {
  const now = params.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const [conversation] = await tx
        .select({ title: assistantConversations.title })
        .from(assistantConversations)
        .where(eq(assistantConversations.id, params.conversationId))
        .for("update");
      if (!conversation) throw new Error("conversation vanished");

      const [pending] = await tx
        .select({ id: assistantMessages.id })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.conversationId, params.conversationId),
            eq(assistantMessages.role, "assistant"),
            inArray(assistantMessages.status, ["queued", "streaming"])
          )
        )
        .limit(1);
      if (pending) return "busy";

      // Two inserts, so the user message gets the smaller uuidv7 id.
      const [question] = await tx
        .insert(assistantMessages)
        .values({
          conversationId: params.conversationId,
          role: "user",
          status: "done",
          content: params.text,
          attachmentIds: params.attachmentIds,
          environmentId: params.environment?.id ?? null,
          environmentName: params.environment?.name ?? null,
          finishedAt: now,
        })
        .returning({ id: assistantMessages.id });
      const [answer] = await tx
        .insert(assistantMessages)
        .values({
          conversationId: params.conversationId,
          role: "assistant",
          status: "queued",
        })
        .returning({ id: assistantMessages.id });
      if (!question || !answer)
        throw new Error("message insert returned no row");

      await tx
        .update(assistantConversations)
        .set({
          updatedAt: now,
          ...(conversation.title ? {} : { title: titleFrom(params.text) }),
        })
        .where(eq(assistantConversations.id, params.conversationId));
      return { userMessageId: question.id, assistantMessageId: answer.id };
    });
  } catch (error) {
    if (isMissingEnvironment(error)) return "environment_gone";
    throw error;
  }
}

/** queued → failed, for a turn whose job could not be enqueued. */
export async function failQueuedMessage(
  messageId: string,
  errorCode: string,
  now: Date = new Date()
): Promise<void> {
  await db
    .update(assistantMessages)
    .set({ status: "failed", errorCode, finishedAt: now })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "queued")
      )
    );
}

export type StreamSnapshot = {
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  toolCalls: ToolCallMeta[];
};

/** What the stream of one assistant message shows; null once it is gone. */
export async function readStreamSnapshot(
  messageId: string
): Promise<StreamSnapshot | null> {
  const [message] = await db
    .select({
      content: assistantMessages.content,
      status: assistantMessages.status,
      errorCode: assistantMessages.errorCode,
    })
    .from(assistantMessages)
    .where(eq(assistantMessages.id, messageId))
    .limit(1);
  if (!message) return null;
  const calls = await toolCallsByMessage([messageId]);
  return { ...message, toolCalls: calls.get(messageId) ?? [] };
}
