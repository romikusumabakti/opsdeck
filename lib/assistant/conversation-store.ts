import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assistantConversations,
  assistantDrafts,
  assistantFiles,
  assistantMessages,
  assistantToolCalls,
  environments,
  instanceSettings,
  issues,
  projects,
} from "@/lib/db/schema";
import {
  contextColumns,
  contextFromRow,
  contextListLabel,
  type MessageContext,
  messageContextOf,
  type QuestionContext,
  type StoredQuestionContext,
} from "./context";
import {
  attachUploads,
  type UploadSummary,
  uploadsOfConversation,
} from "./file-store";
import { readsFilesNatively } from "./providers";
import type { AssistantSource } from "./sources";
import type { AssistantPart } from "./turn-parts";

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

/** The admin switch, cap and provider, without decrypting the key. */
export async function loadAssistantLimits(): Promise<{
  enabled: boolean;
  hasApiKey: boolean;
  dailyCapUsd: number;
  /** The configured model reads images (providers.ts readsFilesNatively). */
  readsImages: boolean;
}> {
  const [row] = await db
    .select({
      enabled: instanceSettings.assistantEnabled,
      apiKey: instanceSettings.assistantApiKey,
      dailyCapUsd: instanceSettings.assistantDailyCapUsd,
      provider: instanceSettings.assistantProvider,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return {
    enabled: row?.enabled ?? false,
    hasApiKey: !!row?.apiKey,
    dailyCapUsd: Number(row?.dailyCapUsd ?? 0),
    readsImages: row?.provider ? readsFilesNatively(row.provider) : true,
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

export type ConversationListItem = {
  id: string;
  title: string;
  updatedAt: Date;
  /** When the user pinned it; null when not pinned. */
  pinnedAt: Date | null;
  /**
   * The name of the project or environment (with its project) the latest
   * question pinned, kept once deleted; null for an automatic one or no
   * question yet.
   */
  lastContextLabel: string | null;
  /** The latest question's project or environment was deleted since. */
  lastContextDeleted: boolean;
};

/** The longest chat search query, in characters. */
export const SEARCH_QUERY_MAX_CHARS = 200;

/** `text` as a literal ILIKE pattern: its wildcards and escapes matched as-is. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type ConversationList = {
  /** Most recently pinned first. */
  pinned: ConversationListItem[];
  /** The rest, newest (updated_at) first. */
  recent: ConversationListItem[];
};

/**
 * The user's conversations, all projects: the pinned ones (most recently
 * pinned first) and the rest (newest first). Temporary chats are never
 * listed. With a `query`, only chats whose title or any message (question
 * or answer) contains it, case-insensitively.
 */
export async function listConversationsOf(
  userId: string,
  options: { query?: string } = {}
): Promise<ConversationList> {
  const query = options.query?.trim() ?? "";
  const filters: SQL[] = [
    eq(assistantConversations.userId, userId),
    eq(assistantConversations.temporary, false),
  ];
  if (query) {
    const pattern = containsPattern(query);
    const match = or(
      ilike(assistantConversations.title, pattern),
      exists(
        db
          .select({ one: sql`1` })
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.conversationId, assistantConversations.id),
              ilike(assistantMessages.content, pattern)
            )
          )
      )
    );
    if (match) filters.push(match);
  }
  const conversations = await db
    .select({
      id: assistantConversations.id,
      title: assistantConversations.title,
      updatedAt: assistantConversations.updatedAt,
      pinnedAt: assistantConversations.pinnedAt,
    })
    .from(assistantConversations)
    .where(and(...filters))
    .orderBy(
      sql`${assistantConversations.pinnedAt} desc nulls last`,
      desc(assistantConversations.updatedAt)
    );
  const items = await withContextLabels(conversations);
  return {
    pinned: items.filter((c) => c.pinnedAt !== null),
    recent: items.filter((c) => c.pinnedAt === null),
  };
}

/** Each conversation with the label of its latest question's context. */
async function withContextLabels(
  conversations: Omit<
    ConversationListItem,
    "lastContextLabel" | "lastContextDeleted"
  >[]
): Promise<ConversationListItem[]> {
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
    latest.map((row) => [row.conversationId, contextListLabel(row)])
  );
  return conversations.map((c) => ({
    ...c,
    lastContextLabel: labelOf.get(c.id)?.label ?? null,
    lastContextDeleted: labelOf.get(c.id)?.deleted ?? false,
  }));
}

/**
 * A conversation; each question then carries its own context (insertTurn).
 * A temporary one is never listed, searched, pinned or auto-titled, and the
 * hourly prune deletes it 24 h after its last activity.
 */
export async function insertConversation(values: {
  userId: string;
  temporary?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(assistantConversations)
    .values({ userId: values.userId, temporary: values.temporary ?? false })
    .returning({ id: assistantConversations.id });
  if (!row) throw new Error("conversation insert returned no row");
  return row.id;
}

/**
 * Pins or unpins the user's conversation. Pinning keeps an existing pin's
 * time (and so its place); updated_at stays, so Recent keeps its order.
 * "not_found" for another user's or an unknown chat, "temporary" for a
 * temporary chat (never pinned); nothing written either way.
 */
export async function setConversationPinned(
  userId: string,
  conversationId: string,
  pinned: boolean,
  now: Date = new Date()
): Promise<"ok" | "not_found" | "temporary"> {
  const [row] = await db
    .select({ temporary: assistantConversations.temporary })
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.userId, userId)
      )
    )
    .limit(1);
  if (!row) return "not_found";
  if (row.temporary) return "temporary";
  const updated = await db
    .update(assistantConversations)
    .set({
      pinnedAt: pinned
        ? sql`coalesce(${assistantConversations.pinnedAt}, ${now})`
        : null,
    })
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.userId, userId),
        eq(assistantConversations.temporary, false)
      )
    )
    .returning({ id: assistantConversations.id });
  // Deleted (or pruned) between the check and the write.
  return updated.length > 0 ? "ok" : "not_found";
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

/**
 * Sets the title the user chose, which the auto title then never
 * overwrites; updated_at stays, so the list keeps its order.
 */
export async function updateConversationTitle(
  conversationId: string,
  title: string
): Promise<void> {
  await db
    .update(assistantConversations)
    .set({ title, titleSource: "user" })
    .where(eq(assistantConversations.id, conversationId));
}

export type TitleInput = {
  userId: string;
  question: string;
  answer: string;
  answerMessageId: string;
};

/**
 * What the auto title is made from: the first question and its done answer.
 * Null (no title to make) unless the conversation still has its first-message
 * title, is not temporary, has exactly one question and that question's
 * answer is done.
 */
export async function loadTitleInput(
  conversationId: string
): Promise<TitleInput | null> {
  const [conversation] = await db
    .select({ userId: assistantConversations.userId })
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.titleSource, "first_message"),
        eq(assistantConversations.temporary, false)
      )
    )
    .limit(1);
  if (!conversation) return null;
  const messages = await db
    .select({
      id: assistantMessages.id,
      role: assistantMessages.role,
      status: assistantMessages.status,
      content: assistantMessages.content,
    })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId))
    .orderBy(asc(assistantMessages.id))
    .limit(3);
  const [question, answer, more] = messages;
  if (
    more ||
    question?.role !== "user" ||
    answer?.role !== "assistant" ||
    answer.status !== "done"
  ) {
    return null;
  }
  return {
    userId: conversation.userId,
    question: question.content,
    answer: answer.content,
    answerMessageId: answer.id,
  };
}

/**
 * Stores the auto title, unless the user renamed the chat (or it was titled
 * already, or is temporary) meanwhile: the check and the write are one
 * statement. False when nothing was written.
 */
export async function saveGeneratedTitle(
  conversationId: string,
  title: string
): Promise<boolean> {
  const saved = await db
    .update(assistantConversations)
    .set({ title, titleSource: "generated" })
    .where(
      and(
        eq(assistantConversations.id, conversationId),
        eq(assistantConversations.titleSource, "first_message"),
        eq(assistantConversations.temporary, false)
      )
    )
    .returning({ id: assistantConversations.id });
  return saved.length > 0;
}

/**
 * Deletes a conversation in one transaction: its messages, tool calls,
 * drafts and files go with it (ON DELETE CASCADE); usage rows stay, their
 * message nulled. Returns the storage keys of the deleted files, for the
 * caller to remove after the commit. The row is locked first, so a question
 * or a file attached meanwhile waits and then finds the chat gone.
 */
export async function deleteConversationRows(
  conversationId: string
): Promise<string[]> {
  return (await deleteRowsIf(conversationId)) ?? [];
}

/**
 * deleteConversationRows; with `idleBefore`, only while the chat is still a
 * temporary one idle since before it. Null when nothing was deleted.
 */
async function deleteRowsIf(
  conversationId: string,
  idleBefore?: Date
): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          // The prune's own check, again under the lock: a question asked
          // meanwhile keeps the chat.
          idleBefore
            ? and(
                eq(assistantConversations.temporary, true),
                lt(assistantConversations.updatedAt, idleBefore)
              )
            : undefined
        )
      )
      .for("update");
    if (!conversation) return null;
    const files = await tx
      .delete(assistantFiles)
      .where(
        or(
          eq(assistantFiles.conversationId, conversationId),
          inArray(
            assistantFiles.messageId,
            tx
              .select({ id: assistantMessages.id })
              .from(assistantMessages)
              .where(eq(assistantMessages.conversationId, conversationId))
          )
        )
      )
      .returning({ storageKey: assistantFiles.storageKey });
    await tx
      .delete(assistantConversations)
      .where(eq(assistantConversations.id, conversationId));
    return files.map((f) => f.storageKey);
  });
}

export type ToolCallMeta = { tool: string; meta: Record<string, unknown> };

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  sources: AssistantSource[] | null;
  /**
   * Answers: the ordered UIMessage parts (lib/assistant/turn-parts.ts); null
   * on user messages and on answers from before parts, which render from
   * content.
   */
  parts: AssistantPart[] | null;
  attachmentIds: string[];
  /** User messages: the files uploaded with the question. */
  files: UploadSummary[];
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
  /** A temporary chat (shown with a badge; never listed). */
  temporary: boolean;
  /** When the user pinned it; null when not pinned. */
  pinnedAt: Date | null;
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
      userId: assistantConversations.userId,
      temporary: assistantConversations.temporary,
      pinnedAt: assistantConversations.pinnedAt,
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
        parts: assistantMessages.parts,
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
  const [calls, uploads] = await Promise.all([
    toolCallsByMessage(
      messages.filter((m) => m.role === "assistant").map((m) => m.id)
    ),
    uploadsOfConversation(conversationId, conversation.userId),
  ]);
  return {
    id: conversation.id,
    title: conversation.title,
    temporary: conversation.temporary,
    pinnedAt: conversation.pinnedAt,
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
        files: (uploads.get(m.id) ?? []).map(
          ({ id, filename, mediaType, size }) => ({
            id,
            filename,
            mediaType,
            size,
          })
        ),
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
 * message's foreign key refuses it. "files_gone" (nothing written) unless
 * every file id is an unsent upload of the conversation's owner; the files
 * are attached to the question in the same transaction.
 */
export async function insertTurn(params: {
  conversationId: string;
  text: string;
  attachmentIds: string[];
  /** The owner's unsent uploads the question carries (file-store). */
  fileIds?: string[];
  context: QuestionContext;
  now?: Date;
}): Promise<CreatedTurn | "busy" | "context_gone" | "files_gone"> {
  const now = params.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const [conversation] = await tx
        .select({
          title: assistantConversations.title,
          userId: assistantConversations.userId,
        })
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

      const attached = await attachUploads(tx, {
        userId: conversation.userId,
        fileIds: params.fileIds ?? [],
        conversationId: params.conversationId,
        messageId: question.id,
      });
      if (!attached) throw new FilesGone();

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
    if (error instanceof FilesGone) return "files_gone";
    throw error;
  }
}

/** Rolls the turn back: a file it names is not the owner's unsent upload. */
class FilesGone extends Error {
  constructor() {
    super("files gone");
    this.name = "FilesGone";
  }
}

/**
 * Replaces the conversation's last answer with a new queued one, for Retry.
 * In one transaction, the conversation row locked first (as insertTurn), so
 * two retries at once cannot both pass: the last message is read by id
 * (uuidv7, so the newest). "busy" when it is a queued or streaming answer,
 * "nothing_to_retry" when it is not an assistant message (no answer yet);
 * nothing written either way. Otherwise it is deleted (its tool calls go
 * with it, its usage rows stay with message_id null) and a new queued
 * assistant message takes its place; its id is newer than the question's, so
 * the turn re-answers the same question.
 */
export async function replaceLastAnswer(
  conversationId: string,
  now: Date = new Date()
): Promise<{ assistantMessageId: string } | "busy" | "nothing_to_retry"> {
  return await db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: assistantConversations.id })
      .from(assistantConversations)
      .where(eq(assistantConversations.id, conversationId))
      .for("update");
    if (!conversation) throw new Error("conversation vanished");

    const [last] = await tx
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        status: assistantMessages.status,
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      .orderBy(desc(assistantMessages.id))
      .limit(1);
    if (last?.role !== "assistant") return "nothing_to_retry";
    if (last.status === "queued" || last.status === "streaming") return "busy";

    await tx.delete(assistantMessages).where(eq(assistantMessages.id, last.id));
    const [answer] = await tx
      .insert(assistantMessages)
      .values({ conversationId, role: "assistant", status: "queued" })
      .returning({ id: assistantMessages.id });
    if (!answer) throw new Error("message insert returned no row");
    await tx
      .update(assistantConversations)
      .set({ updatedAt: now })
      .where(eq(assistantConversations.id, conversationId));
    return { assistantMessageId: answer.id };
  });
}

/**
 * Edit of the last question: replaces the user's last question text and its
 * answer with a new queued one, in one transaction with the conversation row
 * locked first (as replaceLastAnswer). The question keeps its id, context and
 * files. "not_found" for another user's or an unknown chat, "busy" while the
 * last answer is queued or streaming, "nothing_to_edit" before any question;
 * nothing written in each case. The old answer goes (its tool calls with it,
 * its usage rows stay with message_id null). An only question titled from
 * it, or by the auto title made from it, gets the title of its new text (and
 * the auto title runs again after the new answer); a title the user gave
 * stays.
 */
export async function editLastQuestion(
  userId: string,
  conversationId: string,
  text: string,
  now: Date = new Date()
): Promise<CreatedTurn | "not_found" | "busy" | "nothing_to_edit"> {
  return await db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ titleSource: assistantConversations.titleSource })
      .from(assistantConversations)
      .where(
        and(
          eq(assistantConversations.id, conversationId),
          eq(assistantConversations.userId, userId)
        )
      )
      .for("update");
    if (!conversation) return "not_found";

    const messages = await tx
      .select({
        id: assistantMessages.id,
        role: assistantMessages.role,
        status: assistantMessages.status,
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      .orderBy(desc(assistantMessages.id));
    const [last] = messages;
    if (
      last?.role === "assistant" &&
      (last.status === "queued" || last.status === "streaming")
    ) {
      return "busy";
    }
    const question = messages.find((m) => m.role === "user");
    if (!question) return "nothing_to_edit";

    await tx
      .update(assistantMessages)
      .set({ content: text, finishedAt: now })
      .where(eq(assistantMessages.id, question.id));
    // Every answer after the question (there is one at most).
    const answers = messages
      .filter((m) => m.role === "assistant" && m.id > question.id)
      .map((m) => m.id);
    if (answers.length > 0) {
      await tx
        .delete(assistantMessages)
        .where(inArray(assistantMessages.id, answers));
    }
    const [answer] = await tx
      .insert(assistantMessages)
      .values({ conversationId, role: "assistant", status: "queued" })
      .returning({ id: assistantMessages.id });
    if (!answer) throw new Error("message insert returned no row");
    const onlyQuestion = messages.filter((m) => m.role === "user").length === 1;
    await tx
      .update(assistantConversations)
      .set({
        updatedAt: now,
        ...(onlyQuestion && conversation.titleSource !== "user"
          ? { title: titleFrom(text), titleSource: "first_message" }
          : {}),
      })
      .where(eq(assistantConversations.id, conversationId));
    return { userMessageId: question.id, assistantMessageId: answer.id };
  });
}

/** A temporary chat goes this long after its last activity (updated_at). */
export const TEMPORARY_CHAT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes every temporary conversation whose last activity (updated_at:
 * moved by each question, retry and edit) is more than 24 h before `now`,
 * each like deleteConversationRows. Returns how many went and the storage
 * keys of their files, for the caller to remove.
 */
export async function deleteStaleTemporaryConversations(
  now: Date = new Date()
): Promise<{ count: number; storageKeys: string[] }> {
  const idleBefore = new Date(now.getTime() - TEMPORARY_CHAT_TTL_MS);
  const stale = await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.temporary, true),
        lt(assistantConversations.updatedAt, idleBefore)
      )
    );
  let count = 0;
  const storageKeys: string[] = [];
  for (const { id } of stale) {
    const keys = await deleteRowsIf(id, idleBefore);
    if (keys) {
      count += 1;
      storageKeys.push(...keys);
    }
  }
  return { count, storageKeys };
}

/**
 * The context the conversation's latest question asked about (a deleted
 * pinned project or environment reads as "gone"); null before any question.
 */
export async function lastQuestionContext(
  conversationId: string
): Promise<StoredQuestionContext | null> {
  const [row] = await db
    .select({
      projectId: assistantMessages.projectId,
      projectName: assistantMessages.projectName,
      environmentId: assistantMessages.environmentId,
      environmentName: assistantMessages.environmentName,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        eq(assistantMessages.role, "user")
      )
    )
    .orderBy(desc(assistantMessages.id))
    .limit(1);
  return row ? contextFromRow(row) : null;
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

/**
 * queued | streaming → failed (`assistant.stopped`), for the answer the user
 * stopped. Returns its id, or null when none was pending. The content stays as
 * last flushed; the turn's own writes then find the message no longer
 * streaming and end the turn (lib/assistant/run-turn.ts).
 */
export async function stopPendingAnswer(
  conversationId: string,
  now: Date = new Date()
): Promise<string | null> {
  const [stopped] = await db
    .update(assistantMessages)
    .set({ status: "failed", errorCode: "assistant.stopped", finishedAt: now })
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        eq(assistantMessages.role, "assistant"),
        inArray(assistantMessages.status, ["queued", "streaming"])
      )
    )
    .returning({ id: assistantMessages.id });
  return stopped?.id ?? null;
}

export type AnswerState = {
  status: MessageStatus;
  errorCode: string | null;
};

/** The chat's latest answer (by id, uuidv7), null before its first one. */
export async function findLatestAnswer(
  conversationId: string
): Promise<({ id: string } & AnswerState) | null> {
  const [answer] = await db
    .select({
      id: assistantMessages.id,
      status: assistantMessages.status,
      errorCode: assistantMessages.errorCode,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        eq(assistantMessages.role, "assistant")
      )
    )
    .orderBy(desc(assistantMessages.id))
    .limit(1);
  return answer ?? null;
}

/** How an answer stands; null once it is gone with its chat. */
export async function readAnswerStatus(
  messageId: string
): Promise<AnswerState | null> {
  const [answer] = await db
    .select({
      status: assistantMessages.status,
      errorCode: assistantMessages.errorCode,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.role, "assistant")
      )
    )
    .limit(1);
  return answer ?? null;
}
