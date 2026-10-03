"use server";

import { and, eq, isNull, max, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { recordActivity } from "@/lib/activity";
import { assertNotLastAdmin } from "@/lib/access";
import { listActiveAdminIds } from "@/lib/admins";
import { requireOrgPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  invitations,
  projectMembers,
  projects,
  sessions,
  users,
} from "@/lib/db/schema";
import {
  normalizeOrgRole,
  normalizeProjectRole,
  type OrgRole,
  type ProjectRole,
} from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

export type AccessMatrix = {
  projects: { id: string; key: string; name: string }[];
  users: {
    id: string;
    name: string;
    email: string;
    role: OrgRole;
    banned: boolean;
    lastSeen: string | null;
    memberships: Record<string, ProjectRole>;
  }[];
};

export async function getAccessMatrix(): Promise<AccessMatrix> {
  await requireOrgPermission({ audit: ["read"] });
  const [projectRows, userRows, memberRows, lastSeenRows] = await Promise.all([
    db
      .select({ id: projects.id, key: projects.key, name: projects.name })
      .from(projects)
      .orderBy(projects.key),
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        banned: users.banned,
      })
      .from(users)
      .orderBy(users.name),
    db
      .select({
        userId: projectMembers.userId,
        projectId: projectMembers.projectId,
        role: projectMembers.role,
      })
      .from(projectMembers),
    db
      .select({ userId: sessions.userId, lastSeen: max(sessions.updatedAt) })
      .from(sessions)
      .groupBy(sessions.userId),
  ]);
  const lastSeen = new Map(lastSeenRows.map((r) => [r.userId, r.lastSeen]));
  return {
    projects: projectRows,
    users: userRows.map((u) => {
      const memberships: Record<string, ProjectRole> = {};
      for (const m of memberRows) {
        const role = m.userId === u.id ? normalizeProjectRole(m.role) : null;
        if (role) memberships[m.projectId] = role;
      }
      return {
        ...u,
        banned: u.banned ?? false,
        role: normalizeOrgRole(u.role),
        lastSeen: lastSeen.get(u.id)?.toISOString() ?? null,
        memberships,
      };
    }),
  };
}

// Remove a leaver's access in one step: ban (blocks every sign-in path, via the
// admin plugin's session hook), drop their sessions, memberships and pending
// invitations. The user row stays so issues and history keep their author.
export async function offboardUser(userId: string): Promise<ActionResponse> {
  const session = await requireOrgPermission({ user: ["offboard"] });
  const t = await getTranslations("access");
  if (!uuidSchema.safeParse(userId).success) {
    return { success: false, message: t("errorInvalidUser") };
  }
  if (userId === session.user.id) {
    return { success: false, message: t("errorSelf") };
  }
  if (!assertNotLastAdmin(await listActiveAdminIds(), userId, null)) {
    return { success: false, message: t("errorLastAdmin") };
  }
  const [target] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return { success: false, message: t("errorInvalidUser") };

  const removed = await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ banned: true,
        banReason: "offboarded",
        banExpires: null,
        updatedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    const memberships = await tx
      .delete(projectMembers)
      .where(eq(projectMembers.userId, userId))
      .returning({ projectId: projectMembers.projectId });
    await tx
      .delete(invitations)
      .where(
        and(
          eq(sql`lower(${invitations.email})`, target.email.toLowerCase()),
          isNull(invitations.acceptedAt)
        )
      );
    return memberships.length;
  });

  await recordActivity({
    actorId: session.user.id,
    action: "user.offboarded",
    entityType: "access",
    entityId: userId,
    data: { user: target.name, memberships: removed },
  });
  revalidatePath("/admin/access");
  return { success: true, message: t("offboarded") };
}
