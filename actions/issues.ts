"use server";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  ilike,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  environments,
  type Issue,
  type IssueComment,
  issueComments,
  issueLabels,
  issues,
  type LabelLite,
  labels,
  projects,
  users as userTable,
} from "@/lib/db/schema";
import type { IssueSort } from "@/lib/issue-query";
import type { PushableField } from "@/lib/jira/push";
import { notifyIssueAssigned, notifyIssueMention } from "@/lib/notifications";
import { enqueue, type JobMap } from "@/lib/queue";
import type { ActionResponse } from "@/lib/types";
import {
  issueInputSchema,
  issuePrioritySchema,
  issueStatusSchema,
  issueUpdateSchema,
} from "@/lib/validation";

/**
 * Every route whose rendered output depends on issue rows. These are *route
 * patterns*, not concrete URLs: `revalidatePath(pattern, "page")` invalidates
 * every instance of the route, which is the only way to reach locale-prefixed
 * (`/[locale]/…`) and project-scoped paths without enumerating each locale and
 * each project key.
 *
 * Deliberately not `revalidatePath("/", "layout")` — that drops the cache for
 * the whole app (servers, storage, knowledge, users, runs…) on every status
 * flip.
 */
const ISSUE_ROUTES = [
  "/[locale]", // home — "assigned to me" feed
  "/[locale]/issues", // global list
  "/[locale]/projects", // open-issue badges on the project grid
  "/[locale]/activity", // activity log
  "/[locale]/[projectKey]", // project overview counts
  "/[locale]/[projectKey]/[envSlug]/issues", // project-scoped list
  "/[locale]/[projectKey]/issues/[number]", // issue detail
] as const;

/** Invalidate exactly the routes that render issues. */
function revalidateIssues(): void {
  for (const route of ISSUE_ROUTES) revalidatePath(route, "page");
}

/**
 * Which local field edits are mirrored to Jira, and under which name.
 * Everything absent from this map (type, milestone, parent, environment) is
 * OpsDeck-only by design — see lib/jira/push.ts for why the allowlist is small.
 */
const JIRA_PUSHABLE: Record<string, PushableField> = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  assigneeId: "assignee",
};

/**
 * Queue a write-back. Deliberately fire-and-forget from the action's point of
 * view: the handler re-checks that the project is linked and has `pushEnabled`,
 * so an unlinked project just costs one no-op job rather than a lookup on every
 * issue edit. A Redis outage must not fail the edit that already committed, so
 * the enqueue swallows its own errors — the reconcile sweep is the backstop.
 */
async function enqueueJiraPush<
  N extends "jira/push.issue" | "jira/push.comment",
>(name: N, data: JobMap[N]): Promise<void> {
  try {
    await enqueue(name, data, { attempts: 3, backoffMs: 5_000 });
  } catch (error) {
    console.error("Failed to enqueue Jira push:", error);
  }
}

/**
 * Attach each issue's labels in one round-trip (avoids relational M2M). Returns
 * the same rows with a `labels` array added.
 */
async function attachLabels<T extends { id: string }>(
  rows: T[]
): Promise<(T & { labels: LabelLite[] })[]> {
  if (rows.length === 0) return [];
  const pairs = await db
    .select({
      issueId: issueLabels.issueId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(
      inArray(
        issueLabels.issueId,
        rows.map((r) => r.id)
      )
    );
  const byIssue = new Map<string, LabelLite[]>();
  for (const p of pairs) {
    const arr = byIssue.get(p.issueId) ?? [];
    arr.push({ id: p.id, name: p.name, color: p.color });
    byIssue.set(p.issueId, arr);
  }
  return rows.map((r) => ({ ...r, labels: byIssue.get(r.id) ?? [] }));
}

/** Look up a project's issue-key prefix (for notification text). */
async function projectKeyOf(projectId: string): Promise<string> {
  const [row] = await db
    .select({ key: projects.key })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.key ?? "";
}

// An issue plus the display names needed by the list, credential-free.
export type IssueWithMeta = Issue & {
  createdBy: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
  labels: LabelLite[];
};

// Adds the owning project — for the cross-project (global) issues view.
export type GlobalIssue = IssueWithMeta & {
  project: { id: string; name: string; key: string };
};

// Statuses that count as "still needs work" for the open-issue badges.
const OPEN_STATUSES = ["open", "in_progress"] as const;

/** Map of projectId → count of not-yet-resolved issues, for the grid badges. */
export async function getOpenIssueCounts(): Promise<Record<string, number>> {
  await requireSession();
  try {
    const rows = await db
      .select({
        projectId: issues.projectId,
        count: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(inArray(issues.status, [...OPEN_STATUSES]))
      .groupBy(issues.projectId);
    const map: Record<string, number> = {};
    for (const r of rows) map[r.projectId] = Number(r.count);
    return map;
  } catch (error) {
    console.error("Failed to count open issues:", error);
    return {};
  }
}

/**
 * Not-yet-resolved issues assigned to one user, newest-updated first — the
 * "assigned to me" feed on Home.
 */
export async function listAssignedIssues(
  userId: string
): Promise<GlobalIssue[]> {
  await requireSession();
  try {
    const rows = await db.query.issues.findMany({
      where: { assigneeId: userId },
      with: {
        project: { columns: { id: true, name: true, key: true } },
        createdBy: { columns: { id: true, name: true } },
        assignee: { columns: { id: true, name: true } },
        environment: { columns: { id: true, name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const open = rows.filter((i) =>
      (OPEN_STATUSES as readonly string[]).includes(i.status)
    );
    return (await attachLabels(open)) as unknown as GlobalIssue[];
  } catch (error) {
    console.error("Failed to list assigned issues:", error);
    return [];
  }
}

// A subtask/child or the parent, in the minimal shape the detail page links to.
export type IssueRef = {
  id: string;
  number: number;
  title: string;
  status: string;
  type: string;
};

export type IssueDetail = Issue & {
  project: { id: string; name: string; key: string };
  environment: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  labels: LabelLite[];
  parent: IssueRef | null;
  children: IssueRef[];
  comments: (IssueComment & {
    author: { id: string; name: string } | null;
  })[];
};

/** Resolve a single issue by its human key (`CMEM` + number) with its thread. */
export async function getIssueDetail(
  projectKey: string,
  number: number
): Promise<IssueDetail | null> {
  await requireSession();
  try {
    const project = await db.query.projects.findFirst({
      where: { key: projectKey.toUpperCase() },
      columns: { id: true },
    });
    if (!project) return null;
    const issue = await db.query.issues.findFirst({
      where: { projectId: project.id, number },
      with: {
        project: { columns: { id: true, name: true, key: true } },
        environment: { columns: { id: true, name: true } },
        assignee: { columns: { id: true, name: true } },
        createdBy: { columns: { id: true, name: true } },
        comments: {
          with: { author: { columns: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!issue) return null;
    const [withLabels] = await attachLabels([issue]);

    const refCols = {
      id: issues.id,
      number: issues.number,
      title: issues.title,
      status: issues.status,
      type: issues.type,
    };
    const children = await db
      .select(refCols)
      .from(issues)
      .where(eq(issues.parentId, issue.id))
      .orderBy(asc(issues.number));
    let parent: IssueRef | null = null;
    if (issue.parentId) {
      const [p] = await db
        .select(refCols)
        .from(issues)
        .where(eq(issues.id, issue.parentId))
        .limit(1);
      parent = p ?? null;
    }
    return { ...withLabels, parent, children } as unknown as IssueDetail;
  } catch (error) {
    console.error("Failed to load issue detail:", error);
    return null;
  }
}

export async function addComment(
  issueId: string,
  body: string
): Promise<{ success: boolean; message?: string }> {
  const session = await requireSession();
  const trimmed = (body ?? "").trim();
  if (!trimmed) return { success: false, message: "Empty comment" };
  if (trimmed.length > 20_000) {
    return { success: false, message: "Comment too long" };
  }
  try {
    const [created] = await db
      .insert(issueComments)
      .values({
        issueId,
        authorId: session.user.id,
        body: trimmed,
      })
      .returning({ id: issueComments.id });
    // Mirror it to Jira if the project is linked with push on. The job itself
    // re-checks the link and skips comments that already carry a remote id, so
    // enqueuing unconditionally is safe and keeps this action free of Jira
    // knowledge.
    await enqueueJiraPush("jira/push.comment", { commentId: created.id });
    // Notify mentioned users. The comment box inserts exact display names after
    // `@`, so a plain `@${name}` substring scan resolves mentions without a
    // username scheme. Ambiguous only if two users share a display name — rare
    // in a small workspace, and at worst both get notified.
    const issue = await db.query.issues.findFirst({
      where: { id: issueId },
      columns: { number: true, title: true },
      with: { project: { columns: { key: true } } },
    });
    if (issue?.project) {
      const users = await db
        .select({ id: userTable.id, name: userTable.name })
        .from(userTable)
        .where(eq(userTable.banned, false));
      for (const u of users) {
        if (u.id !== session.user.id && trimmed.includes(`@${u.name}`)) {
          await notifyIssueMention({
            userId: u.id,
            actorId: session.user.id,
            projectKey: issue.project.key,
            number: issue.number,
            title: issue.title,
          });
        }
      }
    }
    revalidateIssues();
    return { success: true };
  } catch (error) {
    console.error("Failed to add comment:", error);
    return { success: false, message: "Failed to add comment" };
  }
}

/** Filter/sort/page state of the global issue list — mirrors the URL query. */
export type IssueQuery = {
  /** Free text over the title and the human key (`CMEM-42`). */
  q?: string;
  status?: string;
  projectId?: string;
  labelId?: string;
  priority?: string;
  /** Restrict to one assignee — the "assigned to me" toggle. */
  assigneeId?: string;
  sort?: IssueSort;
  desc?: boolean;
  offset?: number;
  limit?: number;
};

export type IssuePage = {
  rows: GlobalIssue[];
  /** Rows matching the filter *before* limit/offset — drives the pager. */
  total: number;
};

// Hard ceiling on one page so a crafted `?ps=100000` can't ask the database for
// the whole table.
const MAX_PAGE_SIZE = 200;

/**
 * One page of issues across all projects.
 *
 * Filtering, searching, sorting and paging all happen in SQL: the list is
 * unbounded by nature (every project, forever), so pulling it into memory to
 * filter client-side stops working long before the product does.
 *
 * Written with the core query builder rather than the relational API because it
 * needs a search predicate spanning `projects.key`, an EXISTS sub-query for the
 * label filter, and a matching COUNT — none of which the relational `where`
 * shorthand expresses.
 */
export async function listAllIssues(
  query: IssueQuery = {}
): Promise<IssuePage> {
  await requireSession();

  const assigneeUser = alias(userTable, "assignee_user");
  const creatorUser = alias(userTable, "creator_user");

  const conditions: SQL[] = [];
  const q = query.q?.trim();
  if (q) {
    const pattern = `%${q}%`;
    const search = or(
      ilike(issues.title, pattern),
      // Bug reports bury the searchable detail (an error string, a route, a
      // ticket ref) in the body, so the description is part of the haystack.
      ilike(issues.description, pattern),
      // The key the user sees ("CMEM-42") exists only as a composite, so match
      // it as one — searching "CMEM-42" should find exactly that issue.
      sql`(${projects.key} || '-' || ${issues.number}) ILIKE ${pattern}`
    );
    if (search) conditions.push(search);
  }
  // Every filter value arrives from the URL: validate before it reaches SQL so
  // a junk enum value is ignored rather than throwing a 22P02 from Postgres.
  const status = issueStatusSchema.safeParse(query.status);
  if (status.success) conditions.push(eq(issues.status, status.data));
  const priority = issuePrioritySchema.safeParse(query.priority);
  if (priority.success) conditions.push(eq(issues.priority, priority.data));
  if (isUuid(query.projectId)) {
    conditions.push(eq(issues.projectId, query.projectId));
  }
  if (isUuid(query.assigneeId)) {
    conditions.push(eq(issues.assigneeId, query.assigneeId));
  }
  if (isUuid(query.labelId)) {
    // EXISTS, not a join: a join through the M2M table would multiply rows and
    // corrupt both the COUNT and the page size.
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(issueLabels)
          .where(
            and(
              eq(issueLabels.issueId, issues.id),
              eq(issueLabels.labelId, query.labelId)
            )
          )
      )
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const ascending = query.desc === false;
  const dir = ascending ? asc : desc;
  const orderBy: SQL[] = {
    key: [dir(projects.key), dir(issues.number)],
    title: [dir(issues.title)],
    project: [dir(projects.name)],
    status: [dir(issues.status)],
    // Enum columns order by their declaration order (low → urgent), which is
    // the urgency ranking users expect — not alphabetical.
    priority: [dir(issues.priority)],
    // Unassigned rows sort last in both directions — an empty cell is never the
    // most interesting row on the page.
    assignee: [
      ascending
        ? sql`${assigneeUser.name} ASC NULLS LAST`
        : sql`${assigneeUser.name} DESC NULLS LAST`,
    ],
    createdAt: [dir(issues.createdAt)],
    updatedAt: [dir(issues.updatedAt)],
  }[query.sort ?? "updatedAt"];

  const limit = Math.min(Math.max(1, query.limit ?? 25), MAX_PAGE_SIZE);
  const offset = Math.max(0, query.offset ?? 0);

  try {
    const [rows, [counted]] = await Promise.all([
      db
        .select({
          issue: getTableColumns(issues),
          projectName: projects.name,
          projectKey: projects.key,
          assigneeName: assigneeUser.name,
          creatorName: creatorUser.name,
          environmentName: environments.name,
        })
        .from(issues)
        .innerJoin(projects, eq(projects.id, issues.projectId))
        .leftJoin(assigneeUser, eq(assigneeUser.id, issues.assigneeId))
        .leftJoin(creatorUser, eq(creatorUser.id, issues.createdById))
        .leftJoin(environments, eq(environments.id, issues.environmentId))
        .where(where)
        // `id` last so the order is total: without it, rows sharing the sort
        // key can swap between pages and appear twice (or never).
        .orderBy(...orderBy, asc(issues.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .innerJoin(projects, eq(projects.id, issues.projectId))
        .where(where),
    ]);

    const shaped = rows.map((r) => ({
      ...r.issue,
      project: {
        id: r.issue.projectId,
        name: r.projectName,
        key: r.projectKey,
      },
      assignee: r.issue.assigneeId
        ? { id: r.issue.assigneeId, name: r.assigneeName ?? "" }
        : null,
      createdBy: r.issue.createdById
        ? { id: r.issue.createdById, name: r.creatorName ?? "" }
        : null,
      environment: r.issue.environmentId
        ? { id: r.issue.environmentId, name: r.environmentName ?? "" }
        : null,
    }));

    return {
      rows: await attachLabels(shaped),
      total: Number(counted?.count ?? 0),
    };
  } catch (error) {
    console.error("Failed to list all issues:", error);
    return { rows: [], total: 0 };
  }
}

function isUuid(value: string | undefined): value is string {
  return !!value && z.uuid().safeParse(value).success;
}

/** All issues for a logical project, newest first. */
export async function listIssues(projectId: string): Promise<IssueWithMeta[]> {
  await requireSession();
  try {
    const rows = await db.query.issues.findMany({
      where: { projectId },
      with: {
        createdBy: { columns: { id: true, name: true } },
        assignee: { columns: { id: true, name: true } },
        environment: { columns: { id: true, name: true } },
      },
      orderBy: { number: "desc" },
    });
    return (await attachLabels(rows)) as unknown as IssueWithMeta[];
  } catch (error) {
    console.error("Failed to list issues:", error);
    return [];
  }
}

/**
 * Create an issue. The per-project `number` (→ KEY-N) is assigned as
 * max(number)+1 inside a transaction; a concurrent create can still collide on
 * the unique (project_id, number) index, so retry a few times on 23505.
 */
export async function createIssue(
  data: unknown
): Promise<ActionResponse<Issue>> {
  const session = await requireSession();
  const parsed = issueInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid issue data" };
  }
  const input = parsed.data;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const created = await db.transaction(async (tx) => {
        const [{ max }] = await tx
          .select({
            max: sql<number>`coalesce(max(${issues.number}), 0)`,
          })
          .from(issues)
          .where(eq(issues.projectId, input.projectId));
        const [row] = await tx
          .insert(issues)
          .values({
            projectId: input.projectId,
            number: Number(max) + 1,
            title: input.title,
            description: input.description ?? "",
            type: input.type,
            priority: input.priority,
            environmentId: input.environmentId ?? null,
            assigneeId: input.assigneeId ?? null,
            milestoneId: input.milestoneId ?? null,
            parentId: input.parentId ?? null,
            createdById: session.user.id,
          })
          .returning();
        return row;
      });
      const projectKey = await projectKeyOf(input.projectId);
      if (input.assigneeId) {
        await notifyIssueAssigned({
          assigneeId: input.assigneeId,
          actorId: session.user.id,
          projectKey,
          number: created.number,
          title: created.title,
        });
      }
      await recordActivity({
        actorId: session.user.id,
        action: "issue.created",
        entityType: "issue",
        entityId: created.id,
        data: { key: `${projectKey}-${created.number}`, title: created.title },
      });
      revalidateIssues();
      return { success: true, data: created };
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") continue; // retry
      console.error("Failed to create issue:", error);
      return { success: false, message: "Failed to create issue" };
    }
  }
  return { success: false, message: "Failed to create issue" };
}

export async function updateIssue(
  id: string,
  data: unknown
): Promise<ActionResponse<Issue>> {
  const session = await requireSession();
  const parsed = issueUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid issue data" };
  }
  // An issue can't be its own parent. (Deeper cycles are avoided in the UI by
  // excluding descendants from the parent picker.)
  if (parsed.data.parentId === id) {
    return { success: false, message: "An issue cannot be its own parent" };
  }
  try {
    const [updated] = await db
      .update(issues)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(issues.id, id))
      .returning();
    if (!updated) return { success: false, message: "Issue not found" };
    // Notify on (re)assignment to someone other than the actor.
    if ("assigneeId" in parsed.data && parsed.data.assigneeId) {
      await notifyIssueAssigned({
        assigneeId: parsed.data.assigneeId,
        actorId: session.user.id,
        projectKey: await projectKeyOf(updated.projectId),
        number: updated.number,
        title: updated.title,
      });
    }
    if (updated.jiraIssueId) {
      const fields = Object.keys(parsed.data)
        .map((column) => JIRA_PUSHABLE[column])
        .filter((field): field is PushableField => field !== undefined);
      if (fields.length > 0) {
        await enqueueJiraPush("jira/push.issue", {
          issueId: updated.id,
          fields,
        });
      }
    }
    if (parsed.data.status) {
      await recordActivity({
        actorId: session.user.id,
        action: "issue.status_changed",
        entityType: "issue",
        entityId: updated.id,
        data: {
          key: `${await projectKeyOf(updated.projectId)}-${updated.number}`,
          status: parsed.data.status,
        },
      });
    }
    revalidateIssues();
    return { success: true, data: updated };
  } catch (error) {
    console.error(`Failed to update issue ${id}:`, error);
    return { success: false, message: "Failed to update issue" };
  }
}

/** Convenience for the common inline status change on the board/list. */
export async function setIssueStatus(
  id: string,
  status: string
): Promise<ActionResponse<Issue>> {
  return updateIssue(id, { status });
}

/** Set the status of many issues at once (bulk triage on the list). */
export async function bulkSetStatus(
  ids: string[],
  status: string
): Promise<{ success: boolean; message?: string }> {
  await requireSession();
  const parsed = issueStatusSchema.safeParse(status);
  if (!parsed.success) return { success: false, message: "Invalid status" };
  if (ids.length === 0) return { success: true };
  try {
    await db
      .update(issues)
      .set({ status: parsed.data, updatedAt: new Date() })
      .where(inArray(issues.id, ids));
    revalidateIssues();
    return { success: true };
  } catch (error) {
    console.error("Failed to bulk-update issues:", error);
    return { success: false, message: "Failed to update issues" };
  }
}

/** Delete many issues at once. */
export async function bulkDeleteIssues(
  ids: string[]
): Promise<{ success: boolean; message?: string }> {
  await requireSession();
  if (ids.length === 0) return { success: true };
  try {
    await db.delete(issues).where(inArray(issues.id, ids));
    revalidateIssues();
    return { success: true };
  } catch (error) {
    console.error("Failed to bulk-delete issues:", error);
    return { success: false, message: "Failed to delete issues" };
  }
}

/** Delete an issue (creator or admin gate is enforced in the UI/route). */
export async function deleteIssue(id: string): Promise<ActionResponse> {
  await requireSession();
  try {
    await db.delete(issues).where(and(eq(issues.id, id)));
    revalidateIssues();
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete issue ${id}:`, error);
    return { success: false, message: "Failed to delete issue" };
  }
}
