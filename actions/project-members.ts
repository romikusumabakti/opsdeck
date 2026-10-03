"use server";

import { and, eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { projectMembers, projects, users as userTable } from "@/lib/db/schema";
import { isProjectRole, type ProjectRole } from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

export type ProjectMemberRow = {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
};

function isValidRole(role: string): role is ProjectRole {
  return isProjectRole(role);
}

// Managing membership needs member:manage on the project (maintainer, or an
// admin/infra org role).
export async function listProjectMembers(
  projectId: string
): Promise<ProjectMemberRow[]> {
  await requireProjectPermission({ projectId }, { member: ["manage"] });
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

// Everyone who could be added to the project: every non-banned user, by name.
// The picker drops current members itself. Membership is how an org `member`
// gains access to a project, so this list deliberately reaches beyond the
// project's current members (unlike listAssignableUsers).
export async function listMemberCandidates(
  projectId: string
): Promise<{ id: string; name: string; email: string }[]> {
  await requireProjectPermission({ projectId }, { member: ["manage"] });
  return db
    .select({ id: userTable.id, name: userTable.name, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.banned, false))
    .orderBy(userTable.name);
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
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { member: ["manage"] }
  );
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
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { member: ["manage"] }
  );
  const t = await getTranslations("projectMembers");
  if (!uuidSchema.safeParse(input.userId).success) {
    return { success: false, message: t("errorInvalidInput") };
  }
  if (!isValidRole(input.role)) {
    return { success: false, message: t("errorInvalidRole") };
  }
  const [previous] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId)
      )
    )
    .limit(1);
  if (!previous) return { success: false, message: t("errorInvalidInput") };
  await db
    .update(projectMembers)
    .set({ role: input.role })
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId)
      )
    );
  await recordActivity({
    actorId: session.user.id,
    action: "member.roleChanged",
    entityType: "member",
    entityId: input.userId,
    data: {
      ...(await memberNames(input.projectId, input.userId)),
      from: previous.role,
      to: input.role,
    },
  });
  return { success: true, message: t("roleUpdatedSuccess") };
}

export async function removeProjectMember(input: {
  projectId: string;
  userId: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { member: ["manage"] }
  );
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
