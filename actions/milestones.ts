"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { requireProjectPage, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import { issues, type Milestone, milestones } from "@/lib/db/schema";
import type { ActionResponse } from "@/lib/types";
import { milestoneInputSchema, uuidSchema } from "@/lib/validation";

// A milestone plus how many issues point at it — the count drives the
// management list and warns before deleting a non-empty one.
export type MilestoneWithCount = Milestone & { issueCount: number };

// Private ("use server" files expose every export): the project that owns a
// milestone, or null when the id is malformed or unknown.
async function milestoneProjectId(id: string): Promise<string | null> {
  // Signed-in callers only, before any lookup: the result tells a caller
  // whether a milestone id exists.
  await requireSession();
  if (!uuidSchema.safeParse(id).success) return null;
  const [row] = await db
    .select({ projectId: milestones.projectId })
    .from(milestones)
    .where(eq(milestones.id, id))
    .limit(1);
  return row?.projectId ?? null;
}

/** All milestones for a project, open ones first, then by due date. */
export async function listMilestones(
  projectId: string
): Promise<MilestoneWithCount[]> {
  await requireProjectPage({ projectId });
  try {
    const rows = await db
      .select({
        id: milestones.id,
        projectId: milestones.projectId,
        name: milestones.name,
        description: milestones.description,
        dueAt: milestones.dueAt,
        closedAt: milestones.closedAt,
        createdAt: milestones.createdAt,
        issueCount: sql<number>`count(${issues.id})::int`,
      })
      .from(milestones)
      .leftJoin(issues, eq(issues.milestoneId, milestones.id))
      .where(eq(milestones.projectId, projectId))
      .groupBy(milestones.id)
      // Open (closedAt null) first, then nearest due date, then newest.
      .orderBy(
        sql`${milestones.closedAt} is not null`,
        asc(milestones.dueAt),
        asc(milestones.createdAt)
      );
    return rows as MilestoneWithCount[];
  } catch (error) {
    console.error("Failed to list milestones:", error);
    return [];
  }
}

export async function createMilestone(
  data: unknown
): Promise<ActionResponse<Milestone>> {
  const parsed = milestoneInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid milestone data" };
  }
  const input = parsed.data;
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { issue: ["write"] }
  );
  try {
    const row = one(
      await db
        .insert(milestones)
        .values({
          projectId: input.projectId,
          name: input.name,
          description: input.description || null,
          dueAt: input.dueAt ?? null,
        })
        .returning(),
      "milestone"
    );
    await recordActivity({
      actorId: session.user.id,
      action: "milestone.created",
      entityType: "milestone",
      entityId: row.id,
      data: { name: row.name },
    });
    revalidatePath("/", "layout");
    return { success: true, data: row };
  } catch (error) {
    console.error("Failed to create milestone:", error);
    return { success: false, message: "Failed to create milestone" };
  }
}

export async function updateMilestone(
  id: string,
  data: unknown
): Promise<ActionResponse<Milestone>> {
  const projectId = await milestoneProjectId(id);
  if (!projectId) return { success: false, message: "Milestone not found" };
  await requireProjectPermission({ projectId }, { issue: ["write"] });
  const parsed = milestoneInputSchema.partial().safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid milestone data" };
  }
  // projectId is immutable — a milestone can't move between projects.
  const { projectId: _ignored, ...fields } = parsed.data;
  try {
    const row = one(
      await db
        .update(milestones)
        .set(fields)
        .where(eq(milestones.id, id))
        .returning(),
      "milestone"
    );
    if (!row) return { success: false, message: "Milestone not found" };
    revalidatePath("/", "layout");
    return { success: true, data: row };
  } catch (error) {
    console.error(`Failed to update milestone ${id}:`, error);
    return { success: false, message: "Failed to update milestone" };
  }
}

/** Toggle a milestone's open/closed state. */
export async function setMilestoneClosed(
  id: string,
  closed: boolean
): Promise<ActionResponse<Milestone>> {
  const projectId = await milestoneProjectId(id);
  if (!projectId) return { success: false, message: "Milestone not found" };
  await requireProjectPermission({ projectId }, { issue: ["write"] });
  try {
    const row = one(
      await db
        .update(milestones)
        .set({ closedAt: closed ? new Date() : null })
        .where(eq(milestones.id, id))
        .returning(),
      "milestone"
    );
    if (!row) return { success: false, message: "Milestone not found" };
    revalidatePath("/", "layout");
    return { success: true, data: row };
  } catch (error) {
    console.error(`Failed to toggle milestone ${id}:`, error);
    return { success: false, message: "Failed to update milestone" };
  }
}

/** Delete a milestone. Issues pointing at it fall back to null (FK set null). */
export async function deleteMilestone(id: string): Promise<ActionResponse> {
  const projectId = await milestoneProjectId(id);
  if (!projectId) return { success: false, message: "Milestone not found" };
  await requireProjectPermission({ projectId }, { issue: ["delete"] });
  try {
    await db.delete(milestones).where(and(eq(milestones.id, id)));
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete milestone ${id}:`, error);
    return { success: false, message: "Failed to delete milestone" };
  }
}
