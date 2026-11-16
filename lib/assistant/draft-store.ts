import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assistantConversations,
  assistantDrafts,
  assistantMessages,
  projects,
  users,
} from "@/lib/db/schema";
import type { ConversationOwner } from "./conversation-store";

/**
 * The Postgres side of assistant drafts. No authorization here: the service
 * (server/services/assistant.ts) checks the caller first.
 */

export type DraftKind = "brd" | "jira";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DraftTranscript = {
  projectName: string;
  environmentName: string;
  /** User questions and finished answers, oldest first. */
  messages: { role: "user" | "assistant"; content: string }[];
};

/** The text turns a draft is written from; null if the conversation is gone. */
export async function loadDraftTranscript(
  conversationId: string
): Promise<DraftTranscript | null> {
  const [conversation] = await db
    .select({
      projectName: projects.name,
      environmentName: assistantConversations.environmentName,
    })
    .from(assistantConversations)
    .innerJoin(projects, eq(projects.id, assistantConversations.projectId))
    .where(eq(assistantConversations.id, conversationId))
    .limit(1);
  if (!conversation) return null;
  const rows = await db
    .select({
      role: assistantMessages.role,
      content: assistantMessages.content,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        or(
          eq(assistantMessages.role, "user"),
          and(
            eq(assistantMessages.role, "assistant"),
            eq(assistantMessages.status, "done")
          )
        )
      )
    )
    // uuidv7 ids sort by creation.
    .orderBy(asc(assistantMessages.id));
  return {
    ...conversation,
    messages: rows.filter((m) => m.content.trim() !== ""),
  };
}

export async function insertDraft(values: {
  conversationId: string;
  kind: DraftKind;
  content: Record<string, unknown>;
}): Promise<string> {
  const [row] = await db
    .insert(assistantDrafts)
    .values(values)
    .returning({ id: assistantDrafts.id });
  if (!row) throw new Error("draft insert returned no row");
  return row.id;
}

export type DraftOwner = {
  conversation: ConversationOwner;
  kind: DraftKind;
  issueId: string | null;
};

/** A draft with the conversation that owns it. */
export async function findDraftOwner(
  draftId: string
): Promise<DraftOwner | null> {
  const [row] = await db
    .select({
      id: assistantConversations.id,
      userId: assistantConversations.userId,
      projectId: assistantConversations.projectId,
      kind: assistantDrafts.kind,
      issueId: assistantDrafts.issueId,
    })
    .from(assistantDrafts)
    .innerJoin(
      assistantConversations,
      eq(assistantConversations.id, assistantDrafts.conversationId)
    )
    .where(eq(assistantDrafts.id, draftId))
    .limit(1);
  if (!row) return null;
  const { kind, issueId, ...conversation } = row;
  return { conversation, kind, issueId };
}

/** Replaces a draft's content; false once it has become a Jira issue. */
export async function updateDraftContent(
  draftId: string,
  content: Record<string, unknown>,
  now: Date = new Date()
): Promise<boolean> {
  const rows = await db
    .update(assistantDrafts)
    .set({ content, updatedAt: now })
    // A draft that became a Jira issue stays the record of what was sent.
    .where(
      and(eq(assistantDrafts.id, draftId), isNull(assistantDrafts.issueId))
    )
    .returning({ id: assistantDrafts.id });
  return rows.length > 0;
}

export type LockedDraft = {
  id: string;
  kind: DraftKind;
  content: Record<string, unknown>;
  issueId: string | null;
  projectId: string;
};

/** The draft row, locked until `tx` ends (one Jira create per draft). */
export async function lockDraft(
  tx: Tx,
  draftId: string
): Promise<LockedDraft | null> {
  const [row] = await tx
    .select({
      id: assistantDrafts.id,
      kind: assistantDrafts.kind,
      content: assistantDrafts.content,
      issueId: assistantDrafts.issueId,
      projectId: assistantConversations.projectId,
    })
    .from(assistantDrafts)
    .innerJoin(
      assistantConversations,
      eq(assistantConversations.id, assistantDrafts.conversationId)
    )
    .where(eq(assistantDrafts.id, draftId))
    .for("update", { of: assistantDrafts });
  return row ?? null;
}

export async function linkDraftIssue(
  tx: Tx,
  draftId: string,
  issueId: string,
  now: Date = new Date()
): Promise<void> {
  await tx
    .update(assistantDrafts)
    .set({ issueId, updatedAt: now })
    .where(eq(assistantDrafts.id, draftId));
}

/** The display name and project key an issue created from a draft needs. */
export async function loadCreateContext(
  userId: string,
  projectId: string
): Promise<{ actorName: string | null; projectKey: string | null }> {
  const [[user], [project]] = await Promise.all([
    db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
  ]);
  return { actorName: user?.name ?? null, projectKey: project?.key ?? null };
}
