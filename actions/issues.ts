"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type Issue,
  type IssueComment,
  issueComments,
  issueLabels,
  issues,
  type LabelLite,
  labels,
  projects,
} from "@/lib/db/schema";
import { notifyIssueAssigned } from "@/lib/notifications";
import { issueInputSchema, issueUpdateSchema } from "@/lib/validation";

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

export type IssueDetail = Issue & {
  project: { id: string; name: string; key: string };
  environment: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  labels: LabelLite[];
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
    return withLabels as unknown as IssueDetail;
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
    await db.insert(issueComments).values({
      issueId,
      authorId: session.user.id,
      body: trimmed,
    });
    revalidatePath("/projects", "layout");
    return { success: true };
  } catch (error) {
    console.error("Failed to add comment:", error);
    return { success: false, message: "Failed to add comment" };
  }
}

/** Every issue across all projects, newest-updated first — the global view. */
export async function listAllIssues(): Promise<GlobalIssue[]> {
  await requireSession();
  try {
    const rows = await db.query.issues.findMany({
      with: {
        project: { columns: { id: true, name: true, key: true } },
        createdBy: { columns: { id: true, name: true } },
        assignee: { columns: { id: true, name: true } },
        environment: { columns: { id: true, name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    return (await attachLabels(rows)) as unknown as GlobalIssue[];
  } catch (error) {
    console.error("Failed to list all issues:", error);
    return [];
  }
}

type ActionResponse = { success: boolean; message?: string; data?: Issue };

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
export async function createIssue(data: unknown): Promise<ActionResponse> {
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
            createdById: session.user.id,
          })
          .returning();
        return row;
      });
      if (input.assigneeId) {
        await notifyIssueAssigned({
          assigneeId: input.assigneeId,
          actorId: session.user.id,
          projectKey: await projectKeyOf(input.projectId),
          number: created.number,
          title: created.title,
        });
      }
      revalidatePath("/projects", "layout");
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
): Promise<ActionResponse> {
  const session = await requireSession();
  const parsed = issueUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid issue data" };
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
    revalidatePath("/projects", "layout");
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
): Promise<ActionResponse> {
  return updateIssue(id, { status });
}

/** Delete an issue (creator or admin gate is enforced in the UI/route). */
export async function deleteIssue(id: string): Promise<ActionResponse> {
  await requireSession();
  try {
    await db.delete(issues).where(and(eq(issues.id, id)));
    revalidatePath("/projects", "layout");
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete issue ${id}:`, error);
    return { success: false, message: "Failed to delete issue" };
  }
}
