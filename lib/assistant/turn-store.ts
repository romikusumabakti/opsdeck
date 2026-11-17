import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assistantConversations,
  assistantMessages,
  assistantToolCalls,
  projects,
  users,
} from "@/lib/db/schema";
import type { AssistantSource } from "./sources";

/**
 * The Postgres side of one assistant turn (lib/assistant/run-turn.ts): load
 * the message and its conversation, move it through its statuses, and record
 * tool calls. Kept apart from the loop so the loop is testable without a
 * database.
 */

export type TurnHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  status: "queued" | "streaming" | "done" | "failed";
};

export type TurnContext = {
  messageId: string;
  status: "queued" | "streaming" | "done" | "failed";
  /** Text saved so far (non-empty only for an interrupted turn). */
  content: string;
  conversationId: string;
  userId: string;
  userName: string;
  projectId: string;
  projectName: string;
  /**
   * The source of the question this turn answers, from its user message:
   * an environment id, or null for the project branches — unless
   * environmentName is set, which means the asked-about environment was
   * deleted since (the id is set null, the name snapshot stays).
   */
  environmentId: string | null;
  environmentName: string | null;
  /** Messages before this one, oldest first. */
  history: TurnHistoryMessage[];
  /** Attachment ids ticked on the user message this turn answers. */
  attachmentIds: string[];
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
      projectId: assistantConversations.projectId,
      projectName: projects.name,
    })
    .from(assistantMessages)
    .innerJoin(
      assistantConversations,
      eq(assistantConversations.id, assistantMessages.conversationId)
    )
    .innerJoin(users, eq(users.id, assistantConversations.userId))
    .innerJoin(projects, eq(projects.id, assistantConversations.projectId))
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
      attachmentIds: assistantMessages.attachmentIds,
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

  const lastUser = earlier.findLast((m) => m.role === "user");
  return {
    messageId: row.id,
    status: row.status,
    content: row.content,
    conversationId: row.conversationId,
    userId: row.userId,
    userName: row.userName,
    projectId: row.projectId,
    projectName: row.projectName,
    environmentId: lastUser?.environmentId ?? null,
    environmentName: lastUser?.environmentName ?? null,
    history: earlier.map((m) => ({
      role: m.role,
      content: m.content,
      status: m.status,
    })),
    attachmentIds: lastUser?.attachmentIds ?? [],
  };
}

/** queued → streaming. False when the message was no longer queued. */
export async function claimMessage(messageId: string): Promise<boolean> {
  const claimed = await db
    .update(assistantMessages)
    .set({ status: "streaming" })
    .where(
      and(
        eq(assistantMessages.id, messageId),
        eq(assistantMessages.status, "queued")
      )
    )
    .returning({ id: assistantMessages.id });
  return claimed.length > 0;
}

export async function saveContent(
  messageId: string,
  content: string
): Promise<void> {
  await db
    .update(assistantMessages)
    .set({ content })
    .where(eq(assistantMessages.id, messageId));
}

export async function saveSources(
  messageId: string,
  sources: AssistantSource[]
): Promise<void> {
  await db
    .update(assistantMessages)
    .set({ sources })
    .where(eq(assistantMessages.id, messageId));
}

/** streaming → done | failed. A no-op once the message is terminal. */
export async function finishMessage(
  messageId: string,
  outcome:
    | { status: "done"; content: string }
    | { status: "failed"; content: string; errorCode: string },
  now: Date = new Date()
): Promise<void> {
  await db
    .update(assistantMessages)
    .set({
      status: outcome.status,
      content: outcome.content,
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

export async function recordToolCall(
  messageId: string,
  tool: string,
  input: Record<string, unknown>,
  resultMeta: Record<string, unknown>
): Promise<void> {
  await db
    .insert(assistantToolCalls)
    .values({ messageId, tool, input, resultMeta });
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
