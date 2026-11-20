import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assistantConversations,
  assistantMessages,
  assistantToolCalls,
  users,
} from "@/lib/db/schema";
import { pgErrorCode } from "@/lib/domains/errors";
import { effectiveTimeZone } from "@/lib/timezone";
import { contextFromRow, type StoredQuestionContext } from "./context";
import {
  type UploadRef,
  type UploadSummary,
  uploadsOfConversation,
} from "./file-store";
import type { AssistantSource } from "./sources";
import type { AssistantPart } from "./turn-parts";

/**
 * The Postgres side of one assistant turn (lib/assistant/run-turn.ts): load
 * the message and its conversation, move it through its statuses, and record
 * tool calls. Kept apart from the loop so the loop is testable without a
 * database. The user may delete the chat mid-turn: the writes then report
 * the message as gone (false) instead of throwing, and the loop stops.
 */

export type TurnHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  status: "queued" | "streaming" | "done" | "failed";
  /** Why a failed answer failed; absent or null otherwise. */
  errorCode?: string | null;
  /** User messages: the context asked about; null on assistant messages. */
  context: StoredQuestionContext | null;
  /** User messages: the files uploaded with the question. */
  files: UploadSummary[];
};

export type TurnContext = {
  messageId: string;
  status: "queued" | "streaming" | "done" | "failed";
  /** Text saved so far (non-empty only for an interrupted turn). */
  content: string;
  conversationId: string;
  userId: string;
  userName: string;
  /** What the user asked to be called, or null (buildSystemPrompt). */
  preferredName: string | null;
  /** The user's job title, or null (buildSystemPrompt). */
  userTitle: string | null;
  /**
   * The zone the user reads dates in: their own when set and valid, else
   * APP_TIMEZONE (effectiveTimeZone). "Today" and shown times use it.
   */
  timeZone: string;
  /**
   * The context of the question this turn answers, from its user message
   * as stored: not yet checked against the user's current access (runTurn
   * does), and "gone" once the pinned project or environment was deleted.
   */
  context: StoredQuestionContext;
  /** Messages before this one, oldest first. */
  history: TurnHistoryMessage[];
  /** Attachment ids ticked on the user message this turn answers. */
  attachmentIds: string[];
  /**
   * Every file uploaded with the chat's questions up to this turn: what
   * read_upload may read.
   */
  uploads: UploadRef[];
};

/** Null when the message does not exist or is not an assistant message. */
export async function loadTurn(messageId: string): Promise<TurnContext | null> {
  const [row] = await db
    .select({
      id: assistantMessages.id,
      role: assistantMessages.role,
      status: assistantMessages.status,
      content: assistantMessages.content,
      conversationId: assistantMessages.conversationId,
      userId: assistantConversations.userId,
      userName: users.name,
      preferredName: users.preferredName,
      userTitle: users.title,
      timezone: users.timezone,
    })
    .from(assistantMessages)
    .innerJoin(
      assistantConversations,
      eq(assistantConversations.id, assistantMessages.conversationId)
    )
    .innerJoin(users, eq(users.id, assistantConversations.userId))
    .where(eq(assistantMessages.id, messageId))
    .limit(1);
  if (row?.role !== "assistant") return null;

  // uuidv7 ids sort by creation, which breaks ties between rows inserted in
  // the same transaction (same created_at).
  const earlier = await db
    .select({
      id: assistantMessages.id,
      role: assistantMessages.role,
      content: assistantMessages.content,
      status: assistantMessages.status,
      errorCode: assistantMessages.errorCode,
      attachmentIds: assistantMessages.attachmentIds,
      projectId: assistantMessages.projectId,
      projectName: assistantMessages.projectName,
      environmentId: assistantMessages.environmentId,
      environmentName: assistantMessages.environmentName,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.conversationId, row.conversationId),
        lt(assistantMessages.id, row.id)
      )
    )
    .orderBy(asc(assistantMessages.id));

  const uploads = await uploadsOfConversation(
    row.conversationId,
    row.userId,
    row.id
  );
  const lastUser = earlier.findLast((m) => m.role === "user");
  return {
    messageId: row.id,
    status: row.status,
    content: row.content,
    conversationId: row.conversationId,
    userId: row.userId,
    userName: row.userName,
    preferredName: row.preferredName,
    userTitle: row.userTitle,
    timeZone: effectiveTimeZone(row),
    context: lastUser ? contextFromRow(lastUser) : { kind: "auto" },
    history: earlier.map((m) => ({
      role: m.role,
      content: m.content,
      status: m.status,
      errorCode: m.errorCode,
      context: m.role === "user" ? contextFromRow(m) : null,
      files: (uploads.get(m.id) ?? []).map(
        ({ id, filename, mediaType, size }) => ({
          id,
          filename,
          mediaType,
          size,
        })
      ),
    })),
    attachmentIds: lastUser?.attachmentIds ?? [],
    uploads: [...uploads.values()].flat(),
  };
}

/**
 * queued → streaming, recording the answer's UI stream id: the message id
 * (every turn, a retry or an edit too, writes a fresh message). False when
 * the message was no longer queued.
 */
export async function claimMessage(messageId: string): Promise<boolean> {
  const claimed = await db
    .update(assistantMessages)
    .set({ status: "streaming", activeStreamId: messageId })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "queued")
      )
    )
    .returning({ id: assistantMessages.id });
  return claimed.length > 0;
}

/**
 * Clears the answer's stream id once its turn ended, however it ended (a
 * stopped answer is no longer streaming, so there is no status guard).
 */
export async function releaseStream(messageId: string): Promise<void> {
  await db
    .update(assistantMessages)
    .set({ activeStreamId: null })
    .where(eq(assistantMessages.id, messageId));
}

/**
 * The final parts of an answer someone else ended mid-turn (stopped, or
 * failed by the boot sweep): the content it kept stays. A no-op for an
 * answer still streaming or done, or gone with its chat.
 */
export async function saveEndedParts(
  messageId: string,
  parts: AssistantPart[]
): Promise<void> {
  await db
    .update(assistantMessages)
    .set({ parts })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "failed")
      )
    );
}

/**
 * The parts so far and the answer text they hold. False when the message is
 * gone or no longer streaming (its chat was deleted, or the answer was
 * stopped).
 */
export async function saveParts(
  messageId: string,
  value: { parts: AssistantPart[]; content: string }
): Promise<boolean> {
  const saved = await db
    .update(assistantMessages)
    .set({ parts: value.parts, content: value.content })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "streaming")
      )
    )
    .returning({ id: assistantMessages.id });
  return saved.length > 0;
}

/**
 * False when the message is gone or no longer streaming (its chat was
 * deleted, or the answer was stopped).
 */
export async function saveSources(
  messageId: string,
  sources: AssistantSource[]
): Promise<boolean> {
  const saved = await db
    .update(assistantMessages)
    .set({ sources })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "streaming")
      )
    )
    .returning({ id: assistantMessages.id });
  return saved.length > 0;
}

/**
 * streaming → done | failed. A no-op once the message is terminal. Without
 * `parts`, the parts saved so far are kept (a redelivered turn).
 */
export async function finishMessage(
  messageId: string,
  outcome:
    | { status: "done"; content: string; parts: AssistantPart[] }
    | {
        status: "failed";
        content: string;
        parts?: AssistantPart[];
        errorCode: string;
      },
  now: Date = new Date()
): Promise<void> {
  await db
    .update(assistantMessages)
    .set({
      status: outcome.status,
      content: outcome.content,
      ...(outcome.parts ? { parts: outcome.parts } : {}),
      errorCode: outcome.status === "failed" ? outcome.errorCode : null,
      finishedAt: now,
    })
    // The first terminal write wins: a turn the boot sweep already failed
    // (or a second finish) stays as it is.
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "streaming")
      )
    );
}

/**
 * False (nothing written) when the message is gone or no longer streaming: its
 * chat was deleted or the answer was stopped. The status check and the insert
 * are one statement, so a stop never lets another call be audited.
 */
export async function recordToolCall(
  messageId: string,
  tool: string,
  input: Record<string, unknown>,
  resultMeta: Record<string, unknown>
): Promise<boolean> {
  try {
    const inserted = await db
      .insert(assistantToolCalls)
      .select(
        db
          .select({
            messageId: assistantMessages.id,
            tool: sql<string>`${tool}`.as("tool"),
            input: sql<
              Record<string, unknown>
            >`${JSON.stringify(input)}::text::jsonb`.as("input"),
            resultMeta: sql<
              Record<string, unknown>
            >`${JSON.stringify(resultMeta)}::text::jsonb`.as("result_meta"),
          })
          .from(assistantMessages)
          .where(
            and(
              eq(assistantMessages.id, messageId),
              eq(assistantMessages.status, "streaming")
            )
          )
      )
      .returning({ id: assistantToolCalls.id });
    return inserted.length > 0;
  } catch (error) {
    if (pgErrorCode(error) === "23503") return false;
    throw error;
  }
}

/** A turn cannot legitimately stay queued or streaming this long. */
export const STALE_TURN_MS = 15 * 60 * 1000;

/**
 * Boot sweep: a message still queued or streaming after STALE_TURN_MS lost its
 * worker (restart, crash) and would otherwise spin forever in the UI. Returns
 * how many were failed.
 */
export async function failStaleAssistantMessages(): Promise<number> {
  const failed = await db
    .update(assistantMessages)
    .set({
      status: "failed",
      errorCode: "assistant.interrupted",
      // Its worker is gone, and the stream with it.
      activeStreamId: null,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        inArray(assistantMessages.status, ["queued", "streaming"]),
        // Compared in the database, like the other boot sweeps, so the
        // cutoff and created_at share one clock and time zone.
        sql`${assistantMessages.createdAt} < now() - ${STALE_TURN_MS} * interval '1 millisecond'`
      )
    )
    .returning({ id: assistantMessages.id });
  return failed.length;
}
