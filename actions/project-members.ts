"use server";

import { and, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { requireCapability } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { projectMembers, users as userTable } from "@/lib/db/schema";
import { ROLE_RANK, type UserRole } from "@/lib/roles";
import { projectIdSchema } from "@/lib/validation";

export type ActionResponse =
  | { success: true; message?: string }
  | { success: false; message: string };

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

export async function addProjectMember(input: {
  projectId: string;
  userId: string;
  role: string;
}): Promise<ActionResponse> {
  await requireCapability("admin", { projectId: input.projectId });
  const t = await getTranslations("projectMembers");
  if (
    !projectIdSchema.safeParse(input.projectId).success ||
    !projectIdSchema.safeParse(input.userId).success
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
  await requireCapability("admin", { projectId: input.projectId });
  const t = await getTranslations("projectMembers");
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId)
      )
    );
  return { success: true, message: t("removedSuccess") };
}
