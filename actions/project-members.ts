"use server";

import { and, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { recordActivity } from "@/lib/activity";
import { requireCapability } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { projectMembers, projects, users as userTable } from "@/lib/db/schema";
import { ROLE_RANK, type UserRole } from "@/lib/roles";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

export type ProjectMemberRow = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
};

function isValidRole(role: string): role is UserRole {
  return role in ROLE_RANK;
}

// Managing membership is admin-only (global admin, or a per-project admin). The
// scope is the LOGICAL project id — membership is inherited by every environment
// under it. Read the panel and mutate it behind the same `admin` capability.
export async function listProjectMembers(
  projectId: string
): Promise<ProjectMemberRow[]> {
  await requireCapability("admin", { projectId });
  const rows = await db
    .select({
      userId: projectMembers.userId,
      name: userTable.name,
      email: userTable.email,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(userTable, eq(userTable.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(userTable.name);
  return rows as ProjectMemberRow[];
}

// Snapshot the user + project display names for the activity feed so it reads
// without joins even after a membership row changes.
async function memberNames(projectId: string, userId: string) {
  const [[u], [p]] = await Promise.all([
    db
      .select({ name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1),
    db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
  ]);
  return { user: u?.name ?? "?", project: p?.name ?? "?" };
}

export async function addProjectMember(input: {
  projectId: string;
  userId: string;
  role: string;
}): Promise<ActionResponse> {
  const session = await requireCapability("admin", {
    projectId: input.projectId,
  });
  const t = await getTranslations("projectMembers");
  if (
    !uuidSchema.safeParse(input.projectId).success ||
    !uuidSchema.safeParse(input.userId).success
  ) {
    return { success: false, message: t("errorInvalidInput") };
  }
  if (!isValidRole(input.role)) {
    return { success: false, message: t("errorInvalidRole") };
  }
  try {
    // Idempotent: re-adding an existing member updates their role instead of
    // erroring on the (project_id, user_id) primary key.
    await db
      .insert(projectMembers)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
      })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role: input.role },
      });
  } catch {
    return { success: false, message: t("errorAddFailed") };
  }
  const names = await memberNames(input.projectId, input.userId);
  await recordActivity({
    actorId: session.user.id,
    action: "member.added",
    entityType: "member",
    entityId: input.userId,
    data: { ...names, role: input.role },
  });
  return { success: true, message: t("addedSuccess") };
}

export async function updateProjectMemberRole(input: {
  projectId: string;
  userId: string;
  role: string;
}): Promise<ActionResponse> {
  await requireCapability("admin", { projectId: input.projectId });
  const t = await getTranslations("projectMembers");
  if (!isValidRole(input.role)) {
    return { success: false, message: t("errorInvalidRole") };
  }
  await db
    .update(projectMembers)
    .set({ role: input.role })
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId)
      )
    );
  return { success: true, message: t("roleUpdatedSuccess") };
}

export async function removeProjectMember(input: {
  projectId: string;
  userId: string;
}): Promise<ActionResponse> {
  const session = await requireCapability("admin", {
    projectId: input.projectId,
  });
  const t = await getTranslations("projectMembers");
  // Capture names before the row is gone.
  const names = await memberNames(input.projectId, input.userId);
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId)
      )
    );
  await recordActivity({
    actorId: session.user.id,
    action: "member.removed",
    entityType: "member",
    entityId: input.userId,
    data: names,
  });
  return { success: true, message: t("removedSuccess") };
}
