import "server-only";

import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  issueComments,
  issueLabels,
  issuePriorityEnum,
  issueStatusEnum,
  issues,
  issueTypeEnum,
  type JiraConnection,
  type JiraProjectLink,
  jiraConnections,
  jiraProjectLinks,
  labels,
  milestones,
  users,
} from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";
import { richTextToMarkdown } from "./adf";
import { JiraClient, type JiraCredentials } from "./client";
import { mapPriority, mapStatus, mapType } from "./mapping";
import type { JiraIssue } from "./types";

/**
 * The pull half of the Jira integration: fetch remote issues and fold them into
 * the local tracker.
 *
 * Two entry points, one applier. `pullProject` sweeps a linked project by JQL
 * (both the initial import and the periodic reconcile); `syncIssueById` applies
 * a single issue and is what a webhook delivery triggers. Both converge on
 * `applyRemoteIssue`, so there is exactly one place that decides what a remote
 * issue means locally.
 *
 * Everything here is idempotent. Re-running a sweep, replaying a webhook, or
 * overlapping the two changes nothing, because an issue whose remote `updated`
 * is not newer than the `jiraUpdatedAt` we stored is skipped outright. That one
 * guard is also what suppresses the echo of our own push (see ./push.ts).
 */

/**
 * How far to rewind the cursor on each sweep.
 *
 * JQL's `updated` comparison has minute granularity, so an issue modified in
 * the same minute the previous sweep ended can be missed by an exact
 * `updated >= lastSyncAt`. Rewinding re-reads a few minutes of already-applied
 * issues, which costs nothing: they hit the stale-skip and never touch the
 * database.
 */
const SWEEP_OVERLAP_MS = 5 * 60 * 1000;

export type SyncOutcome = {
  scanned: number;
  applied: number;
  skipped: number;
  failed: number;
  /** First failure, kept for `jira_project_links.last_sync_error`. */
  error?: string;
};

/** A link joined to its connection, with the API token already decrypted. */
export type ResolvedLink = {
  link: JiraProjectLink;
  connection: JiraConnection;
  credentials: JiraCredentials;
};

export function credentialsFor(connection: JiraConnection): JiraCredentials {
  return {
    baseUrl: connection.baseUrl,
    flavor: connection.flavor,
    email: connection.email,
    token: decryptSecret(connection.apiToken),
  };
}

export async function resolveLink(
  projectId: string
): Promise<ResolvedLink | null> {
  const [row] = await db
    .select({ link: jiraProjectLinks, connection: jiraConnections })
    .from(jiraProjectLinks)
    .innerJoin(
      jiraConnections,
      eq(jiraConnections.id, jiraProjectLinks.connectionId)
    )
    .where(eq(jiraProjectLinks.projectId, projectId))
    .limit(1);
  if (!row) return null;
  return {
    link: row.link,
    connection: row.connection,
    credentials: credentialsFor(row.connection),
  };
}

/**
 * Build the sweep query. Always `ORDER BY updated ASC` — that ordering is what
 * makes a partially-applied sweep resumable, since the cursor can advance to
 * the last issue that actually landed.
 */
export function buildSweepJql(
  link: Pick<JiraProjectLink, "jiraProjectKey" | "jqlFilter" | "lastSyncAt">,
  options: { full?: boolean } = {}
): string {
  const clauses = [`project = "${link.jiraProjectKey.replace(/"/g, '\\"')}"`];
  if (link.jqlFilter && link.jqlFilter.trim().length > 0) {
    clauses.push(`(${link.jqlFilter.trim()})`);
  }
  if (!options.full && link.lastSyncAt) {
    const since = new Date(link.lastSyncAt.getTime() - SWEEP_OVERLAP_MS);
    clauses.push(`updated >= "${toJqlTimestamp(since)}"`);
  }
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}

/** JQL wants `yyyy/MM/dd HH:mm` in the *site's* timezone; UTC is accepted. */
function toJqlTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/` +
    `${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())}`
  );
}

/**
 * Per-sweep caches. Label and milestone lookups repeat heavily across a page of
 * issues, and the user map is small enough to load once. Scoped to a single
 * sweep so a rename in Jira is picked up on the next one.
 */
type SyncContext = {
  projectId: string;
  client: JiraClient;
  link: JiraProjectLink;
  usersByAccount: Map<string, string>;
  usersByEmail: Map<string, string>;
  labelIds: Map<string, string>;
  milestoneIds: Map<string, string>;
  /** Remote parent id → local child ids, resolved after the sweep. */
  pendingParents: Map<string, string[]>;
};

async function createContext(
  projectId: string,
  link: JiraProjectLink,
  client: JiraClient
): Promise<SyncContext> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      jiraAccountId: users.jiraAccountId,
    })
    .from(users);
  const usersByAccount = new Map<string, string>();
  const usersByEmail = new Map<string, string>();
  for (const row of rows) {
    if (row.jiraAccountId) usersByAccount.set(row.jiraAccountId, row.id);
    usersByEmail.set(row.email.toLowerCase(), row.id);
  }
  return {
    projectId,
    client,
    link,
    usersByAccount,
    usersByEmail,
    labelIds: new Map(),
    milestoneIds: new Map(),
    pendingParents: new Map(),
  };
}

/**
 * Resolve a Jira user to a local one: by stored account id, else by email.
 *
 * An email match also *writes back* the account id, so the mapping is learned
 * once and every later sync is a direct hit — and an admin can correct it by
 * hand afterwards. Unmatched users resolve to null (unassigned) rather than
 * failing the issue: an assignee we don't have an account for is normal.
 */
type RemoteActor = {
  accountId?: string;
  name?: string;
  emailAddress?: string | null;
};

async function resolveUser(
  ctx: SyncContext,
  actor: RemoteActor | null | undefined
): Promise<string | null> {
  if (!actor) return null;
  // Data Center has no accountId; its `name` (username) plays the same role.
  const account = actor.accountId ?? actor.name;
  if (account) {
    const known = ctx.usersByAccount.get(account);
    if (known) return known;
  }
  const email = actor.emailAddress?.toLowerCase();
  if (!email) return null;
  const byEmail = ctx.usersByEmail.get(email);
  if (!byEmail) return null;
  if (account) {
    ctx.usersByAccount.set(account, byEmail);
    await db
      .update(users)
      .set({ jiraAccountId: account })
      .where(eq(users.id, byEmail));
  }
  return byEmail;
}

/** Get-or-create a workspace label by name (names are unique). */
async function resolveLabel(ctx: SyncContext, name: string): Promise<string> {
  const cached = ctx.labelIds.get(name);
  if (cached) return cached;
  const [inserted] = await db
    .insert(labels)
    .values({ name })
    .onConflictDoNothing({ target: labels.name })
    .returning({ id: labels.id });
  let id = inserted?.id;
  if (!id) {
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(eq(labels.name, name))
      .limit(1);
    // The insert hit onConflictDoNothing, so the row existed a moment ago.
    // Gone now means a concurrent delete raced this sweep — throw rather than
    // cache an undefined id, and let the job's retry re-run the insert cleanly.
    if (!existing) {
      throw new Error(`Label "${name}" vanished between insert and lookup`);
    }
    id = existing.id;
  }
  ctx.labelIds.set(name, id);
  return id;
}

/** Get-or-create a milestone by name within the project (fixVersion mirror). */
async function resolveMilestone(
  ctx: SyncContext,
  name: string
): Promise<string> {
  const cached = ctx.milestoneIds.get(name);
  if (cached) return cached;
  const [existing] = await db
    .select({ id: milestones.id })
    .from(milestones)
    .where(
      and(eq(milestones.projectId, ctx.projectId), eq(milestones.name, name))
    )
    .limit(1);
  let id = existing?.id;
  if (!id) {
    const created = one(
      await db
        .insert(milestones)
        .values({ projectId: ctx.projectId, name })
        .returning({ id: milestones.id }),
      "issue"
    );
    id = created.id;
  }
  ctx.milestoneIds.set(name, id);
  return id;
}

/** The local column values a remote issue maps to, minus the relations. */
type MappedFields = {
  title: string;
  description: string;
  status: IssueStatus;
  type: IssueType;
  priority: IssuePriority;
};

function mapFields(remote: JiraIssue, ctx: SyncContext): MappedFields {
  const overrides = ctx.link.mappingOverrides;
  return {
    // A remote summary is never empty in practice, but a null would violate
    // NOT NULL — fall back to the key so the row is still identifiable.
    title: remote.fields.summary?.trim() || remote.key,
    description: richTextToMarkdown(remote.fields.description),
    status: mapStatus(
      {
        name: remote.fields.status?.name ?? "",
        categoryKey: remote.fields.status?.statusCategory?.key,
      },
      overrides
    ),
    type: mapType(remote.fields.issuetype?.name, overrides),
    priority: mapPriority(remote.fields.priority?.name, overrides),
  };
}

/** Replace an issue's labels with the remote set, touching only the diff. */
async function syncLabels(
  ctx: SyncContext,
  issueId: string,
  names: string[]
): Promise<void> {
  const wanted = new Set<string>();
  for (const name of names) wanted.add(await resolveLabel(ctx, name));

  const current = await db
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(eq(issueLabels.issueId, issueId));
  const have = new Set(current.map((row) => row.labelId));

  const toAdd = [...wanted].filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !wanted.has(id));

  if (toAdd.length > 0) {
    await db
      .insert(issueLabels)
      .values(toAdd.map((labelId) => ({ issueId, labelId })))
      .onConflictDoNothing();
  }
  if (toRemove.length > 0) {
    await db
      .delete(issueLabels)
      .where(
        and(
          eq(issueLabels.issueId, issueId),
          inArray(issueLabels.labelId, toRemove)
        )
      );
  }
}

/**
 * Mirror the remote comment thread. Upsert by `jiraCommentId`, and delete local
 * mirrors whose remote counterpart is gone — but never touch comments written
 * in OpsDeck (those have a null `jiraCommentId`), which is the whole reason the
 * delete is scoped to non-null ids.
 */
async function syncComments(
  ctx: SyncContext,
  issueId: string,
  remoteIssueId: string
): Promise<void> {
  const { comments: remote, complete } =
    await ctx.client.getComments(remoteIssueId);
  const seen: string[] = [];

  for (const comment of remote) {
    seen.push(comment.id);
    const body = richTextToMarkdown(comment.body);
    const authorId = await resolveUser(ctx, comment.author);
    const createdAt = comment.created ? new Date(comment.created) : new Date();
    await db
      .insert(issueComments)
      .values({ issueId, authorId, body, createdAt, jiraCommentId: comment.id })
      .onConflictDoUpdate({
        target: issueComments.jiraCommentId,
        set: { body, authorId },
      });
  }

  // Only prune when the whole thread fit in one page — see JiraClient#getComments.
  if (!complete) return;
  await db
    .delete(issueComments)
    .where(
      and(
        eq(issueComments.issueId, issueId),
        isNotNull(issueComments.jiraCommentId),
        seen.length > 0
          ? notInArray(issueComments.jiraCommentId, seen)
          : undefined
      )
    );
}

export type ApplyResult = "applied" | "skipped";

/**
 * Fold one remote issue into the local tracker.
 *
 * Insert-or-update keyed on `jiraIssueId`. Stale revisions (remote `updated` no
 * newer than what we already applied) return `"skipped"` without a write, which
 * is what makes replay and sweep overlap free.
 */
export async function applyRemoteIssue(
  ctx: SyncContext,
  remote: JiraIssue
): Promise<ApplyResult> {
  const remoteUpdated = new Date(remote.fields.updated);

  const [existing] = await db
    .select({
      id: issues.id,
      jiraUpdatedAt: issues.jiraUpdatedAt,
    })
    .from(issues)
    .where(eq(issues.jiraIssueId, remote.id))
    .limit(1);

  if (
    existing?.jiraUpdatedAt &&
    remoteUpdated.getTime() <= existing.jiraUpdatedAt.getTime()
  ) {
    return "skipped";
  }

  const mapped = mapFields(remote, ctx);
  const assigneeId = await resolveUser(ctx, remote.fields.assignee);
  const createdById = await resolveUser(ctx, remote.fields.reporter);
  const versionName = remote.fields.fixVersions?.[0]?.name;
  const milestoneId = versionName
    ? await resolveMilestone(ctx, versionName)
    : null;

  const shared = {
    ...mapped,
    assigneeId,
    milestoneId,
    // The remote timestamp, not `now()`: otherwise a full import would shove
    // every mirrored issue to the top of the "recent activity" ordering.
    updatedAt: remoteUpdated,
    jiraIssueId: remote.id,
    jiraKey: remote.key,
    jiraUpdatedAt: remoteUpdated,
    jiraSyncedAt: new Date(),
  };

  let issueId: string;
  if (existing) {
    await db.update(issues).set(shared).where(eq(issues.id, existing.id));
    issueId = existing.id;
  } else {
    issueId = await insertMirroredIssue(ctx, remote, {
      ...shared,
      createdById,
    });
  }

  await syncLabels(ctx, issueId, remote.fields.labels ?? []);
  await syncComments(ctx, issueId, remote.id);

  // Parents are linked after the sweep: a child often arrives before its epic.
  if (remote.fields.parent) {
    const siblings = ctx.pendingParents.get(remote.fields.parent.id) ?? [];
    siblings.push(issueId);
    ctx.pendingParents.set(remote.fields.parent.id, siblings);
  }

  return "applied";
}

/**
 * Insert a new mirrored issue, allocating the next per-project `number`.
 *
 * Same `max(number) + 1` inside a transaction, retried on the unique violation,
 * as actions/issues.ts#createIssue — a sweep and a human creating an issue can
 * collide on the counter, and the loser just takes the next number.
 */
async function insertMirroredIssue(
  ctx: SyncContext,
  remote: JiraIssue,
  values: Record<string, unknown>
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [highest] = await tx
          .select({ max: sql<number>`coalesce(max(${issues.number}), 0)` })
          .from(issues)
          .where(eq(issues.projectId, ctx.projectId));
        // See createIssue: aggregate row is guaranteed, coalesce supplies 0.
        const max = highest?.max ?? 0;
        const row = one(
          await tx
            .insert(issues)
            .values({
              ...values,
              projectId: ctx.projectId,
              number: Number(max) + 1,
              createdAt: remote.fields.created
                ? new Date(remote.fields.created)
                : new Date(),
            } as typeof issues.$inferInsert)
            .returning({ id: issues.id }),
          "issue"
        );
        return row.id;
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate an issue number for ${remote.key}`);
}

/** Second pass: point mirrored children at whichever parents landed locally. */
async function linkParents(ctx: SyncContext): Promise<void> {
  if (ctx.pendingParents.size === 0) return;
  const remoteIds = [...ctx.pendingParents.keys()];
  const parents = await db
    .select({ id: issues.id, jiraIssueId: issues.jiraIssueId })
    .from(issues)
    .where(inArray(issues.jiraIssueId, remoteIds));

  for (const parent of parents) {
    const childIds = ctx.pendingParents.get(parent.jiraIssueId ?? "");
    if (!childIds || childIds.length === 0) continue;
    await db
      .update(issues)
      .set({ parentId: parent.id })
      // An issue can't parent itself — possible if the remote hierarchy is
      // malformed, and a self-FK cycle would break the subtask tree render.
      .where(
        and(inArray(issues.id, childIds), sql`${issues.id} <> ${parent.id}`)
      );
  }
  ctx.pendingParents.clear();
}

/**
 * Sweep one linked project.
 *
 * Applies page by page and advances the stored cursor to the newest issue that
 * actually landed, so a failure mid-sweep loses no ground: the next run resumes
 * from there instead of restarting the whole project.
 */
export async function pullProject(
  projectId: string,
  options: { full?: boolean } = {}
): Promise<SyncOutcome> {
  const resolved = await resolveLink(projectId);
  if (!resolved) {
    return {
      scanned: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      error: "not linked",
    };
  }
  const { link, credentials } = resolved;
  if (!link.enabled) {
    return { scanned: 0, applied: 0, skipped: 0, failed: 0, error: "disabled" };
  }

  const client = new JiraClient(credentials);
  const ctx = await createContext(projectId, link, client);
  const outcome: SyncOutcome = {
    scanned: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor: Date | null = options.full ? null : link.lastSyncAt;

  try {
    for await (const page of client.searchIssues(
      buildSweepJql(link, options)
    )) {
      for (const remote of page) {
        outcome.scanned++;
        try {
          const result = await applyRemoteIssue(ctx, remote);
          outcome[result === "applied" ? "applied" : "skipped"]++;
          // Ordered ASC by `updated`, so the last success is the high-water
          // mark. Advanced only past issues that applied.
          const updated = new Date(remote.fields.updated);
          if (!cursor || updated > cursor) cursor = updated;
        } catch (error) {
          outcome.failed++;
          outcome.error ??= errorMessage(error);
          console.error(`Jira sync failed for ${remote.key}:`, error);
          // A single bad issue must not abort the sweep, but the cursor stops
          // here so the next run retries it.
          break;
        }
      }
      if (outcome.failed > 0) break;
    }
    await linkParents(ctx);
  } catch (error) {
    outcome.failed++;
    outcome.error ??= errorMessage(error);
    console.error(`Jira sweep failed for project ${projectId}:`, error);
  }

  await db
    .update(jiraProjectLinks)
    .set({
      lastSyncAt: cursor,
      lastSyncStatus:
        outcome.failed === 0
          ? "ok"
          : outcome.applied > 0
            ? "partial"
            : "failed",
      lastSyncError: outcome.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(jiraProjectLinks.projectId, projectId));

  return outcome;
}

/**
 * Apply a single remote issue — the webhook path.
 *
 * The delivered payload is never trusted: the caller passes only the issue id
 * and the issue is re-fetched here. That removes any need to authenticate the
 * body (Jira Cloud's system webhooks can't sign one) and sidesteps the
 * truncation Jira applies to large payloads.
 */
export async function syncIssueById(
  connectionId: string,
  jiraIssueId: string
): Promise<ApplyResult | "unlinked"> {
  const [connection] = await db
    .select()
    .from(jiraConnections)
    .where(eq(jiraConnections.id, connectionId))
    .limit(1);
  if (!connection) return "unlinked";

  const client = new JiraClient(credentialsFor(connection));
  const remote = await client.getIssue(jiraIssueId);

  // Which local project owns it is decided by the remote key's prefix, so an
  // issue moved into a linked project starts mirroring on its next event.
  const remoteProjectKey = remote.key.split("-")[0] ?? remote.key;
  const [link] = await db
    .select()
    .from(jiraProjectLinks)
    .where(
      and(
        eq(jiraProjectLinks.connectionId, connectionId),
        eq(jiraProjectLinks.jiraProjectKey, remoteProjectKey),
        eq(jiraProjectLinks.enabled, true)
      )
    )
    .limit(1);
  if (!link) return "unlinked";

  const ctx = await createContext(link.projectId, link, client);
  const result = await applyRemoteIssue(ctx, remote);
  await linkParents(ctx);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Enum value lists, for validating mapping overrides at the action boundary. */
export const ENUM_VALUES = {
  status: issueStatusEnum.enumValues,
  type: issueTypeEnum.enumValues,
  priority: issuePriorityEnum.enumValues,
} as const;
