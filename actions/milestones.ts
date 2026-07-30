"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { issues, type Milestone, milestones } from "@/lib/db/schema";
import { milestoneInputSchema } from "@/lib/validation";

export type ActionResponse = {
  success: boolean;
  message?: string;
  data?: Milestone;
};

// A milestone plus how many issues point at it — the count drives the
// management list and warns before deleting a non-empty one.
export type MilestoneWithCount = Milestone & { issueCount: number };

/** All milestones for a project, open ones first, then by due date. */
export async function listMilestones(
  projectId: string
): Promise<MilestoneWithCount[]> {
  await requireSession();
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

export async function createMilestone(data: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const parsed = milestoneInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid milestone data" };
  }
  const input = parsed.data;
  try {
    const [row] = await db
      .insert(milestones)
      .values({
        projectId: input.projectId,
        name: input.name,
        description: input.description || null,
        dueAt: input.dueAt ?? null,
      })
      .returning();
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
): Promise<ActionResponse> {
  await requireSession();
  const parsed = milestoneInputSchema.partial().safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid milestone data" };
  }
  // projectId is immutable — a milestone can't move between projects.
  const { projectId: _ignored, ...fields } = parsed.data;
  try {
    const [row] = await db
      .update(milestones)
      .set(fields)
      .where(eq(milestones.id, id))
      .returning();
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
): Promise<ActionResponse> {
  await requireSession();
  try {
    const [row] = await db
      .update(milestones)
      .set({ closedAt: closed ? new Date() : null })
      .where(eq(milestones.id, id))
      .returning();
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
  await requireSession();
  try {
    await db.delete(milestones).where(and(eq(milestones.id, id)));
    revalidatePath("/", "layout");
    return { success: true };
  } catch (error) {
    console.error(`Failed to delete milestone ${id}:`, error);
    return { success: false, message: "Failed to delete milestone" };
  }
}
