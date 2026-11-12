import { and, eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { projectMembers, projects, users as userTable } from "@/lib/db/schema";
import { normalizeOrgRole, type OrgRole } from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";
import { getServerTranslator } from "@/server/i18n";

// A membership carries no role: it lists the person on the project, and what
// they may do there comes from their global role, shown as `orgRole`.
export type ProjectMemberRow = {
  userId: string;
  name: string;
  image: string | null;
  email: string;
  orgRole: OrgRole;
};

// Managing membership needs member:manage on the project (engineer, or an
// admin/infra org role).
export async function listProjectMembers(
  projectId: string
): Promise<ProjectMemberRow[]> {
  await requireProjectPermission({ projectId }, { member: ["manage"] });
  const rows = await db
    .select({
      userId: projectMembers.userId,
      name: userTable.name,
      image: userTable.image,
      email: userTable.email,
      role: userTable.role,
    })
    .from(projectMembers)
    .innerJoin(userTable, eq(userTable.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(userTable.name);
  return rows.map(({ role, ...row }) => ({
    ...row,
    orgRole: normalizeOrgRole(role),
  }));
}

// Everyone who could be added to the project: every non-banned user, by name.
// The picker drops current members itself. Membership is how an engineer or
// QA gains a project, so this list deliberately reaches beyond the project's
// current members (unlike listAssignableUsers).
export async function listMemberCandidates(
  projectId: string
): Promise<
  { id: string; name: string; email: string; image: string | null }[]
> {
  await requireProjectPermission({ projectId }, { member: ["manage"] });
  return db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      image: userTable.image,
    })
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
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { member: ["manage"] }
  );
  const t = await getServerTranslator("projectMembers");
  if (
    !uuidSchema.safeParse(input.projectId).success ||
    !uuidSchema.safeParse(input.userId).success
  ) {
    return { success: false, message: t("errorInvalidInput") };
  }
  let inserted: { userId: string }[];
  try {
    // Idempotent: re-adding an existing member is a no-op on the
    // (project_id, user_id) primary key, not an error.
    inserted = await db
      .insert(projectMembers)
      .values({ projectId: input.projectId, userId: input.userId })
      .onConflictDoNothing()
      .returning({ userId: projectMembers.userId });
  } catch {
    return { success: false, message: t("errorAddFailed") };
  }
  // Only a row that was really added is logged.
  if (inserted.length > 0) {
    await recordActivity({
      actorId: session.user.id,
      action: "member.added",
      entityType: "member",
      entityId: input.userId,
      data: await memberNames(input.projectId, input.userId),
    });
  }
  return { success: true, message: t("addedSuccess") };
}

export async function removeProjectMember(input: {
  projectId: string;
  userId: string;
}): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { projectId: input.projectId },
    { member: ["manage"] }
  );
  const t = await getServerTranslator("projectMembers");
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
