import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assistantConversations,
  assistantDrafts,
  assistantMessages,
  assistantToolCalls,
  environments,
  instanceSettings,
  issues,
  projects,
} from "@/lib/db/schema";
import {
  contextColumns,
  type MessageContext,
  messageContextOf,
  type QuestionContext,
} from "./context";
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

/** The project's name, if it exists. */
export async function findProject(
  projectId: string
): Promise<{ id: string; name: string } | null> {
  const project = await db.query.projects.findFirst({
    where: { id: projectId },
    columns: { id: true, name: true },
  });
  return project ?? null;
}

/** The environment with its project's name, if it exists. */
export async function findEnvironment(environmentId: string): Promise<{
  id: string;
  name: string;
  projectId: string;
  projectName: string;
} | null> {
  const [row] = await db
    .select({
      id: environments.id,
      name: environments.name,
      projectId: environments.projectId,
      projectName: projects.name,
    })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row ?? null;
}

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: Date;
  /**
   * The name of the project or environment the latest question pinned
   * (kept once deleted); null for an automatic one or no question yet.
   */
  lastContextLabel: string | null;
};

/** The user's conversations, all projects, newest first. */
export async function listConversationsOf(
  userId: string
): Promise<ConversationSummary[]> {
  const conversations = await db
    .select({
      id: assistantConversations.id,
      title: assistantConversations.title,
      updatedAt: assistantConversations.updatedAt,
    })
    .from(assistantConversations)
    .where(eq(assistantConversations.userId, userId))
    .orderBy(desc(assistantConversations.updatedAt));
  if (conversations.length === 0) return [];
  // The latest user message of each (uuidv7 ids sort by creation).
  const latest = await db
    .selectDistinctOn([assistantMessages.conversationId], {
      conversationId: assistantMessages.conversationId,
      projectId: assistantMessages.projectId,
      projectName: assistantMessages.projectName,
      environmentId: assistantMessages.environmentId,
      environmentName: assistantMessages.environmentName,
    })
    .from(assistantMessages)
    .where(
      and(
        inArray(
          assistantMessages.conversationId,
          conversations.map((c) => c.id)
        ),
        eq(assistantMessages.role, "user")
      )
    )
    .orderBy(assistantMessages.conversationId, desc(assistantMessages.id));
  const labelOf = new Map(
    latest.map((row) => [row.conversationId, messageContextOf(row).label])
  );
  return conversations.map((c) => ({
    ...c,
    lastContextLabel: labelOf.get(c.id) ?? null,
  }));
}

/** A conversation; each question then carries its own context (insertTurn). */
export async function insertConversation(values: {
  userId: string;
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
};

export async function findConversation(
  conversationId: string
): Promise<ConversationOwner | null> {
  const [row] = await db
    .select({
      id: assistantConversations.id,
      userId: assistantConversations.userId,
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
  /** User messages: the context the question asked about; null on answers. */
  context: MessageContext | null;
  createdAt: Date;
  /** Assistant messages only; result metadata, never the tool input. */
  toolCalls: ToolCallMeta[];
};

export type ConversationDraft = {
  id: string;
  kind: "brd" | "jira";
  content: Record<string, unknown>;
  issueId: string | null;
  /**
   * The project the draft files its issue in; null when none is chosen (the
   * service also blanks one the caller no longer sees).
   */
  projectId: string | null;
  /** The created issue's Jira key; null before creation or once unlinked. */
  jiraKey: string | null;
  /** The created Panel issue's number (`/<KEY>/issues/<n>`); null before. */
  issueNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationDetail = {
  id: string;
  title: string;
  messages: ConversationMessage[];
  drafts: ConversationDraft[];
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
    })
    .from(assistantConversations)
    .where(eq(assistantConversations.id, conversationId))
    .limit(1);
  if (!conversation) return null;

  const [messages, drafts] = await Promise.all([
    db
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        content: assistantMessages.content,
        status: assistantMessages.status,
        errorCode: assistantMessages.errorCode,
        sources: assistantMessages.sources,
        attachmentIds: assistantMessages.attachmentIds,
        projectId: assistantMessages.projectId,
        projectName: assistantMessages.projectName,
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
        projectId: assistantDrafts.projectId,
        jiraKey: issues.jiraKey,
        issueNumber: issues.number,
        createdAt: assistantDrafts.createdAt,
        updatedAt: assistantDrafts.updatedAt,
      })
      .from(assistantDrafts)
      .leftJoin(issues, eq(issues.id, assistantDrafts.issueId))
      .where(eq(assistantDrafts.conversationId, conversationId))
      .orderBy(asc(assistantDrafts.id)),
  ]);
  const calls = await toolCallsByMessage(
    messages.filter((m) => m.role === "assistant").map((m) => m.id)
  );
  return {
    ...conversation,
    messages: messages.map(
      ({ projectId, projectName, environmentId, environmentName, ...m }) => ({
        ...m,
        context:
          m.role === "user"
            ? messageContextOf({
                projectId,
                projectName,
                environmentId,
                environmentName,
              })
            : null,
        toolCalls: calls.get(m.id) ?? [],
      })
    ),
    drafts,
  };
}

/** The FK error of a user message naming a project or environment that is gone. */
function isMissingContext(error: unknown): boolean {
  const e = error as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  };
  const pg = e?.cause?.code ? e.cause : e;
  return (
    pg?.code === "23503" &&
    (pg.constraint_name ===
      "assistant_messages_environment_id_environments_id_fk" ||
      pg.constraint_name === "assistant_messages_project_id_projects_id_fk")
  );
}

export type CreatedTurn = { userMessageId: string; assistantMessageId: string };

/**
 * In one transaction: the user message (done) with the context it asks about
 * and the assistant message (queued) that answers it, the title from the
 * first message, and the conversation's updated_at. "busy" (nothing written)
 * when an assistant message of the conversation is still queued or
 * streaming. The conversation row is locked first, so two sends at once
 * cannot both pass that check. "context_gone" (nothing written) when the
 * pinned project or environment was deleted after the caller's check: the
 * message's foreign key refuses it.
 */
export async function insertTurn(params: {
  conversationId: string;
  text: string;
  attachmentIds: string[];
  context: QuestionContext;
  now?: Date;
}): Promise<CreatedTurn | "busy" | "context_gone"> {
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
          ...contextColumns(params.context),
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
    if (isMissingContext(error)) return "context_gone";
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
