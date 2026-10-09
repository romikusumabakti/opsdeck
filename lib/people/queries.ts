import "server-only";

import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { getProjectAccess, projectIdsWhere, projectScope } from "@/lib/authz";
import { db } from "@/lib/db";
import { issues, projectMembers, projects, sessions, users } from "@/lib/db/schema";
import { canOrg, effectiveProjectRole, type ProjectRole } from "@/lib/permissions";
import { effectiveTimeZone } from "@/lib/timezone";
import { activeStatus, type WorkingHours } from "@/lib/user-display";

// Reads about OTHER users. Profile fields are public to signed-in users;
// anything carrying a project (memberships, issues, runs) is filtered to the
// VIEWER's projects, so a profile never reveals a project the viewer can't open.

export type PersonSummary = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  title: string | null;
  role: string;
  timeZone: string;
  workingHours: WorkingHours | null;
  status: { emoji: string | null; text: string | null; expiresAt: string | null } | null;
  lastActiveAt: string | null;
  /** Viewer-visible projects this person can also see. */
  projectIds: string[];
  deactivated: boolean;
};

export async function listPeople(viewerRole: string | null | undefined): Promise<PersonSummary[]> {
  const access = await getProjectAccess();
  const visible = Object.keys(access.roles);
  const includeBanned = canOrg(viewerRole, { user: ["list"] });

  const [rows, memberships] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        title: users.title,
        role: users.role,
        timezone: users.timezone,
        workingHours: users.workingHours,
        banned: users.banned,
        statusEmoji: users.statusEmoji,
        statusText: users.statusText,
        statusExpiresAt: users.statusExpiresAt,
        lastActiveAt: max(sessions.updatedAt),
      })
      .from(users)
      .leftJoin(sessions, eq(sessions.userId, users.id))
      .where(includeBanned ? undefined : eq(users.banned, false))
      .groupBy(users.id)
      .orderBy(sql`lower(${users.name})`),
    visible.length
      ? db
          .select({
            userId: projectMembers.userId,
            projectId: projectMembers.projectId,
            role: projectMembers.role,
          })
          .from(projectMembers)
          .where(inArray(projectMembers.projectId, visible))
      : Promise.resolve([]),
  ]);

  const byUser = new Map<string, Map<string, string>>();
  for (const m of memberships) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, new Map());
    byUser.get(m.userId)?.set(m.projectId, m.role);
  }

  return rows.map((u) => {
    const mine = byUser.get(u.id);
    const projectIds = visible.filter(
      (pid) => effectiveProjectRole(u.role, mine?.get(pid)) !== null
    );
    const status = activeStatus(u);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      title: u.title,
      role: u.role,
      timeZone: effectiveTimeZone(u),
      workingHours: u.workingHours ?? null,
      status: status && { ...status, expiresAt: status.expiresAt?.toISOString() ?? null },
      lastActiveAt: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : null,
      projectIds,
      deactivated: u.banned,
    };
  });
}

export async function getPersonProjects(
  userId: string
): Promise<{ id: string; key: string; name: string; role: ProjectRole }[]> {
  const access = await getProjectAccess();
  const [target, memberships, visibleProjects] = await Promise.all([
    db.query.users.findFirst({ where: { id: userId }, columns: { role: true } }),
    db
      .select({ projectId: projectMembers.projectId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId)),
    db
      .select({ id: projects.id, key: projects.key, name: projects.name })
      .from(projects)
      .where(await projectScope(projects.id))
      .orderBy(projects.name),
  ]);
  if (!target) return [];
  const membership = new Map(memberships.map((m) => [m.projectId, m.role]));
  return visibleProjects.flatMap((p) => {
    if (!access.roles[p.id]) return [];
    const role = effectiveProjectRole(target.role, membership.get(p.id));
    return role ? [{ ...p, role }] : [];
  });
}

export type PersonIssue = {
  id: string;
  number: number;
  title: string;
  status: string;
  projectKey: string;
};

export async function listPersonOpenIssues(
  userId: string,
  limit = 20
): Promise<{ items: PersonIssue[]; total: number }> {
  const where = and(
    eq(issues.assigneeId, userId),
    inArray(issues.status, ["open", "in_progress"]),
    await projectScope(issues.projectId)
  );
  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        status: issues.status,
        projectKey: projects.key,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(where)
      .orderBy(sql`${issues.status} = 'in_progress' desc`, desc(issues.updatedAt))
      .limit(limit),
    db.select({ total: count() }).from(issues).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export type PersonRun = {
  id: string;
  description: string;
  status: string;
  kind: string | null;
  runAt: Date;
  environment: { name: string; slug: string; project: { key: string } };
};

export async function listPersonRecentRuns(userId: string, limit = 10): Promise<PersonRun[]> {
  const projectIds = await projectIdsWhere();
  const rows = await db.query.runs.findMany({
    where: { userId, ...(projectIds && { environment: { projectId: projectIds } }) },
    columns: { id: true, description: true, status: true, kind: true, runAt: true },
    with: {
      environment: {
        columns: { name: true, slug: true },
        with: { project: { columns: { key: true } } },
      },
    },
    orderBy: { runAt: "desc" },
    limit,
  });
  return rows as PersonRun[];
}

/** No project data, so not in SCOPED_READS. */
export async function getPersonMeta(userId: string) {
  const [row] = await db
    .select({ createdAt: users.createdAt, lastActiveAt: max(sessions.updatedAt) })
    .from(users)
    .leftJoin(sessions, eq(sessions.userId, users.id))
    .where(eq(users.id, userId))
    .groupBy(users.id);
  return { createdAt: row?.createdAt ?? new Date(0), lastActiveAt: row?.lastActiveAt ?? null };
}
