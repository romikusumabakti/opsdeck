import "server-only";

import { type AnyColumn, eq, inArray, type SQL, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getServerSession, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  environments,
  issues,
  projectMembers,
  projects,
} from "@/lib/db/schema";
import {
  canOrg,
  canProject,
  effectiveProjectRole,
  normalizeOrgRole,
  type OrgPermissions,
  type OrgRole,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";

// The server-side authorization boundary. lib/permissions says what each role
// may do; this module works out which roles the caller holds and enforces them.
//
// Denials: pages call notFound() (a project you can't see doesn't exist);
// server actions throw ForbiddenError (the UI already hides what you can't do,
// so reaching one is a bug or a forged call); route handlers answer 404/403.

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>;

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export type ProjectAccess = {
  all: boolean;
  roles: Record<string, ProjectRole>;
};

export type ProjectScope =
  | { projectId: string }
  | { environmentId: string }
  | { issueId: string };

// Pure: combine the org role and memberships into per-project roles. `all` is
// true when the org role reaches every project, so list queries can skip the
// filter.
export function resolveProjectAccess(
  orgRole: string | null | undefined,
  allProjectIds: string[],
  memberships: { projectId: string; role: string }[]
): ProjectAccess {
  const org = normalizeOrgRole(orgRole);
  const byProject = new Map(memberships.map((m) => [m.projectId, m.role]));
  const all = effectiveProjectRole(org, null) !== null;
  const roles: Record<string, ProjectRole> = {};
  const candidates = all ? allProjectIds : [...byProject.keys()];
  for (const projectId of candidates) {
    const role = effectiveProjectRole(org, byProject.get(projectId));
    if (role) roles[projectId] = role;
  }
  return { all, roles };
}

// Pure: does every project in the set grant `perms`? An invisible project fails.
export function checkProjectAccess(
  access: ProjectAccess,
  projectIds: string[],
  perms: ProjectPermissions
): boolean {
  return projectIds.every((id) => canProject(access.roles[id] ?? null, perms));
}

export async function getOrgRole(): Promise<OrgRole> {
  const session = await requireSession();
  return normalizeOrgRole(session.user.role);
}

export const getProjectAccess = cache(async (): Promise<ProjectAccess> => {
  const session = await requireSession();
  const [allProjects, memberships] = await Promise.all([
    db.select({ id: projects.id }).from(projects),
    db
      .select({
        projectId: projectMembers.projectId,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .where(eq(projectMembers.userId, session.user.id)),
  ]);
  return resolveProjectAccess(
    session.user.role,
    allProjects.map((p) => p.id),
    memberships
  );
});

export async function accessibleProjectIds(): Promise<"all" | string[]> {
  const access = await getProjectAccess();
  return access.all ? "all" : Object.keys(access.roles);
}

// SQL-builder filter for any column holding a project id. Undefined = no filter
// (drizzle's and() drops it); an empty set becomes `false`, never `IN ()`.
export async function projectScope(
  column: AnyColumn
): Promise<SQL | undefined> {
  const ids = await accessibleProjectIds();
  if (ids === "all") return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(column, ids);
}

// The same filter for drizzle's relational query API (RQB v2):
// `where: { projectId: await projectIdsWhere() }`. `{ in: [] }` matches nothing.
export async function projectIdsWhere(): Promise<{ in: string[] } | undefined> {
  const ids = await accessibleProjectIds();
  return ids === "all" ? undefined : { in: ids };
}

const projectIdOfEnvironment = cache(async (environmentId: string) => {
  const [row] = await db
    .select({ projectId: environments.projectId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row?.projectId ?? null;
});

const projectIdOfIssue = cache(async (issueId: string) => {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.projectId ?? null;
});

// Ids often come straight from a URL; a non-uuid resolves to "not found"
// rather than a Postgres "invalid input syntax for type uuid" error.
async function projectIdOf(scope: ProjectScope): Promise<string | null> {
  if ("projectId" in scope) {
    return uuidSchema.safeParse(scope.projectId).success
      ? scope.projectId
      : null;
  }
  if ("environmentId" in scope) {
    return uuidSchema.safeParse(scope.environmentId).success
      ? projectIdOfEnvironment(scope.environmentId)
      : null;
  }
  return uuidSchema.safeParse(scope.issueId).success
    ? projectIdOfIssue(scope.issueId)
    : null;
}

export async function getProjectRole(
  scope: ProjectScope
): Promise<ProjectRole | null> {
  const projectId = await projectIdOf(scope);
  if (!projectId) return null;
  const access = await getProjectAccess();
  return access.roles[projectId] ?? null;
}

export async function requireOrgPermission(
  perms: OrgPermissions
): Promise<Session> {
  const session = await requireSession();
  if (!canOrg(session.user.role, perms)) throw new ForbiddenError();
  return session;
}

export async function requireOrgPage(perms: OrgPermissions): Promise<Session> {
  const session = await requireSession();
  if (!canOrg(session.user.role, perms)) notFound();
  return session;
}

async function resolveScoped(scope: ProjectScope) {
  const session = await requireSession();
  const projectId = await projectIdOf(scope);
  const access = await getProjectAccess();
  const role = projectId ? (access.roles[projectId] ?? null) : null;
  return { session, projectId, role };
}

export async function requireProjectPermission(
  scope: ProjectScope,
  perms: ProjectPermissions
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const { session, projectId, role } = await resolveScoped(scope);
  if (!projectId || !role || !canProject(role, perms))
    throw new ForbiddenError();
  return { session, role, projectId };
}

export async function requireProjectPage(
  scope: ProjectScope,
  perms: ProjectPermissions = { project: ["read"] }
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const { session, projectId, role } = await resolveScoped(scope);
  if (!projectId || !role || !canProject(role, perms)) notFound();
  return { session, role, projectId };
}

export async function requireProjectPermissionForAll(
  projectIds: string[],
  perms: ProjectPermissions
): Promise<Session> {
  const session = await requireSession();
  const access = await getProjectAccess();
  if (!checkProjectAccess(access, [...new Set(projectIds)], perms)) {
    throw new ForbiddenError();
  }
  return session;
}

// Route-handler variants: answer with a status instead of redirecting.
// 404 when the project is invisible, 403 when it is visible but the action is not
// permitted, 401 with no session.
export async function routeProjectGuard(
  scope: ProjectScope,
  perms: ProjectPermissions
): Promise<
  | { ok: true; session: Session; role: ProjectRole }
  | { ok: false; response: Response }
> {
  const session = await getServerSession();
  if (!session)
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  const role = await getProjectRole(scope);
  if (!role)
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  if (!canProject(role, perms)) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  return { ok: true, session, role };
}

export async function routeOrgGuard(
  perms: OrgPermissions
): Promise<{ ok: true; session: Session } | { ok: false; response: Response }> {
  const session = await getServerSession();
  if (!session)
    return {
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    };
  if (!canOrg(session.user.role, perms)) {
    return { ok: false, response: new Response("Forbidden", { status: 403 }) };
  }
  return { ok: true, session };
}
