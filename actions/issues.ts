"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type Issue, issues } from "@/lib/db/schema";
import { issueInputSchema, issueUpdateSchema } from "@/lib/validation";

// An issue plus the display names needed by the list, credential-free.
export type IssueWithMeta = Issue & {
  createdBy: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  environment: { id: string; name: string } | null;
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
    return rows as GlobalIssue[];
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
    return rows as IssueWithMeta[];
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
            environmentId: input.environmentId ?? null,
            assigneeId: input.assigneeId ?? null,
            createdById: session.user.id,
          })
          .returning();
        return row;
      });
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
  await requireSession();
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
