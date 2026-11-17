import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  activityLog,
  assistantConversations,
  assistantDrafts,
  assistantMessages,
  assistantToolCalls,
  issues,
  jiraProjectLinks,
  projects,
  users,
} from "@/lib/db/schema";
import { contextFromRow, type StoredQuestionContext } from "./context";
import type { ConversationOwner } from "./conversation-store";
import { pickDraftProject } from "./draft-project";

/**
 * The Postgres side of assistant drafts. No authorization here: the service
 * (server/services/assistant.ts) checks the caller first.
 */

export type DraftKind = "brd" | "jira";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DraftTranscriptMessage =
  /** A question, with the context it was asked in. */
  | { role: "user"; content: string; context: StoredQuestionContext }
  | { role: "assistant"; content: string };

export type DraftTranscript = {
  /** User questions and finished answers, oldest first. */
  messages: DraftTranscriptMessage[];
};

/** The text turns a draft is written from; null if the conversation is gone. */
export async function loadDraftTranscript(
  conversationId: string
): Promise<DraftTranscript | null> {
  const [conversation] = await db
    .select({ id: assistantConversations.id })
    .from(assistantConversations)
    .where(eq(assistantConversations.id, conversationId))
    .limit(1);
  if (!conversation) return null;
  const rows = await db
    .select({
      role: assistantMessages.role,
      content: assistantMessages.content,
      projectId: assistantMessages.projectId,
      projectName: assistantMessages.projectName,
      environmentId: assistantMessages.environmentId,
      environmentName: assistantMessages.environmentName,
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
    messages: rows
      .filter((m) => m.content.trim() !== "")
      .map(
        ({ role, content, ...row }): DraftTranscriptMessage =>
          role === "user"
            ? { role, content, context: contextFromRow(row) }
            : { role, content }
      ),
  };
}

/**
 * The project a new draft of the conversation is preselected with
 * (lib/assistant/draft-project.ts): the latest question's project, else the
 * project the latest finished answer read most, else a Stage 2
 * conversation's project; only one `sees` accepts (the caller's visible
 * projects), else null.
 */
export async function suggestDraftProject(
  conversationId: string,
  sees: (projectId: string) => boolean
): Promise<string | null> {
  // uuidv7 ids sort by creation.
  const [[question], [answer], [conversation]] = await Promise.all([
    db
      .select({ projectId: assistantMessages.projectId })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.conversationId, conversationId),
          eq(assistantMessages.role, "user")
        )
      )
      .orderBy(desc(assistantMessages.id))
      .limit(1),
    db
      .select({ id: assistantMessages.id, sources: assistantMessages.sources })
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.conversationId, conversationId),
          eq(assistantMessages.role, "assistant"),
          eq(assistantMessages.status, "done")
        )
      )
      .orderBy(desc(assistantMessages.id))
      .limit(1),
    db
      .select({ projectId: assistantConversations.projectId })
      .from(assistantConversations)
      .where(eq(assistantConversations.id, conversationId))
      .limit(1),
  ]);
  // The project key each code tool of the answer read (automatic context).
  const readKeys = answer
    ? (
        await db
          .select({
            key: sql<
              string | null
            >`${assistantToolCalls.resultMeta}->>'project'`,
          })
          .from(assistantToolCalls)
          .where(eq(assistantToolCalls.messageId, answer.id))
          .orderBy(asc(assistantToolCalls.id))
      ).flatMap((call) => (call.key ? [call.key] : []))
    : [];
  const sourceKeys = (answer?.sources ?? []).flatMap((source) =>
    source.projectKey ? [source.projectKey] : []
  );
  const keys = [...new Set([...readKeys, ...sourceKeys])];
  const idOfKey = new Map(
    keys.length === 0
      ? []
      : (
          await db
            .select({ id: projects.id, key: projects.key })
            .from(projects)
            .where(inArray(projects.key, keys))
        ).map((p) => [p.key, p.id])
  );
  // A key that names no project (any more) counts for none.
  const idsOf = (list: string[]) =>
    list.flatMap((key) => {
      const id = idOfKey.get(key);
      return id ? [id] : [];
    });
  return pickDraftProject(
    {
      lastQuestionProjectId: question?.projectId ?? null,
      answerReads: idsOf(readKeys),
      answerSources: idsOf(sourceKeys),
      conversationProjectId: conversation?.projectId ?? null,
    },
    sees
  );
}

export type DraftProject = {
  id: string;
  key: string;
  name: string;
  /** Its Jira link is on and may write back: an issue can be created. */
  jiraPushEnabled: boolean;
};

/** The projects of `ids` by name, for a draft to pick. */
export async function loadDraftProjects(
  ids: readonly string[]
): Promise<DraftProject[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      enabled: jiraProjectLinks.enabled,
      pushEnabled: jiraProjectLinks.pushEnabled,
    })
    .from(projects)
    .leftJoin(jiraProjectLinks, eq(jiraProjectLinks.projectId, projects.id))
    .where(inArray(projects.id, [...ids]))
    .orderBy(asc(projects.name), asc(projects.key));
  return rows.map(({ enabled, pushEnabled, ...project }) => ({
    ...project,
    jiraPushEnabled: !!(enabled && pushEnabled),
  }));
}

export async function insertDraft(values: {
  conversationId: string;
  projectId: string | null;
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
  /** The draft's project; null when it has none. */
  projectId: string | null;
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
      projectId: assistantDrafts.projectId,
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
  const { projectId, kind, issueId, ...conversation } = row;
  return { conversation, projectId, kind, issueId };
}

/**
 * Replaces a draft's content and, given one, its project; false once it has
 * become a Jira issue.
 */
export async function updateDraftContent(
  draftId: string,
  content: Record<string, unknown>,
  options: { projectId?: string; now?: Date } = {}
): Promise<boolean> {
  const rows = await db
    .update(assistantDrafts)
    .set({
      content,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      updatedAt: options.now ?? new Date(),
    })
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
  /** The draft's project; null when none was chosen (no Jira link to use). */
  projectId: string | null;
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
      projectId: assistantDrafts.projectId,
    })
    .from(assistantDrafts)
    .where(eq(assistantDrafts.id, draftId))
    .for("update");
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

/** The local issue mirroring a Jira issue, if one exists (committed or ours). */
export async function findIssueByJiraId(
  tx: Tx,
  jiraIssueId: string
): Promise<{ id: string; number: number } | null> {
  const [row] = await tx
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(eq(issues.jiraIssueId, jiraIssueId))
    .limit(1);
  return row ?? null;
}

/** Names the actor as creator of an adopted mirror the sync left without one. */
export async function claimIssueCreator(
  tx: Tx,
  issueId: string,
  actorId: string
): Promise<void> {
  await tx
    .update(issues)
    .set({ createdById: actorId })
    .where(and(eq(issues.id, issueId), isNull(issues.createdById)));
}

/**
 * The activity action that records a Jira issue created for a draft whose
 * local write then failed. It is also the record a retry reads back, so the
 * retry links that issue instead of creating a second one.
 */
export const UNLINKED_CREATE_ACTION = "issue.jira_create_unlinked";

export type UnlinkedRemote = { jiraIssueId: string; jiraKey: string };

export async function recordUnlinkedRemote(
  draftId: string,
  actorId: string,
  remote: UnlinkedRemote
): Promise<void> {
  await db.insert(activityLog).values({
    actorId,
    action: UNLINKED_CREATE_ACTION,
    entityType: "assistant_draft",
    entityId: draftId,
    data: { jiraIssueId: remote.jiraIssueId, jiraKey: remote.jiraKey },
  });
}

/** The Jira issue an earlier, failed create of this draft left behind. */
export async function findUnlinkedRemote(
  tx: Tx,
  draftId: string
): Promise<UnlinkedRemote | null> {
  const [row] = await tx
    .select({ data: activityLog.data })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.action, UNLINKED_CREATE_ACTION),
        eq(activityLog.entityType, "assistant_draft"),
        eq(activityLog.entityId, draftId)
      )
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const id = row?.data.jiraIssueId;
  const key = row?.data.jiraKey;
  return id && key ? { jiraIssueId: String(id), jiraKey: String(key) } : null;
}
