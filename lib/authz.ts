import { type AnyColumn, eq, inArray, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { getServerSession, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  environments,
  issues,
  projectMembers,
  projects,
} from "@/lib/db/schema";
import {
  canAnyProject,
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
import { requestCache } from "@/server/context";
import { notFound } from "@/server/errors";

// The server-side authorization boundary. lib/permissions says what each role
// may do; this module works out which roles the caller holds and enforces them.
//
// Denials: a project you can't see doesn't exist, so it is a 404; a visible
// project or an org-level action you may not perform is a 403 (the UI already
// hides what you can't do, so reaching one is a bug or a forged call). The
// require* guards throw, and server/errors turns the throw into the response;
// the route* guards return the Response for handlers that want to branch.

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>;

// An HTTPException, so the app's onError answers it with a 403. Kept as its own
// class so callers can still tell a denial apart from any other failure.
export class ForbiddenError extends HTTPException {
  constructor(message = "Forbidden") {
    super(403, { message });
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

export const getProjectAccess = requestCache(
  async (): Promise<ProjectAccess> => {
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
  }
);

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

const projectIdOfEnvironment = requestCache(async (environmentId: string) => {
  const [row] = await db
    .select({ projectId: environments.projectId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row?.projectId ?? null;
});

const projectIdOfIssue = requestCache(async (issueId: string) => {
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

// The page guards predate the API: under Next they rendered the 404 page
// instead of throwing. An API has one way to deny, so they are now plain
// aliases, kept so their call sites (and the scope check in
// tests/authz-guards.test.ts) don't churn.
export const requireOrgPage = requireOrgPermission;

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
  if (!projectId || !role) notFound();
  if (!canProject(role, perms)) throw new ForbiddenError();
  return { session, role, projectId };
}

// Like requireProjectPermission, but one of several alternative requests is
// enough (e.g. a listing that backup or restore roles may both read).
export async function requireAnyProjectPermission(
  scope: ProjectScope,
  alternatives: ProjectPermissions[]
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const { session, projectId, role } = await resolveScoped(scope);
  if (!projectId || !role) notFound();
  if (!canAnyProject(role, alternatives)) throw new ForbiddenError();
  return { session, role, projectId };
}

// Alias of requireProjectPermission (see requireOrgPage), defaulting to the
// read access a page needs.
export function requireProjectPage(
  scope: ProjectScope,
  perms: ProjectPermissions = { project: ["read"] }
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  return requireProjectPermission(scope, perms);
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

// Route-handler variants: return the denial instead of throwing it.
// 404 when the project is invisible, 403 when it is visible but the action is not
// permitted, 401 with no session. Same `{ error }` body as server/errors.
function denial(error: string, status: 401 | 403 | 404): Response {
  return Response.json({ error }, { status });
}

export async function routeProjectGuard(
  scope: ProjectScope,
  perms: ProjectPermissions
): Promise<
  | { ok: true; session: Session; role: ProjectRole }
  | { ok: false; response: Response }
> {
  const session = await getServerSession();
  if (!session) return { ok: false, response: denial("Unauthorized", 401) };
  const role = await getProjectRole(scope);
  if (!role) return { ok: false, response: denial("Not Found", 404) };
  if (!canProject(role, perms)) {
    return { ok: false, response: denial("Forbidden", 403) };
  }
  return { ok: true, session, role };
}

export async function routeOrgGuard(
  perms: OrgPermissions
): Promise<{ ok: true; session: Session } | { ok: false; response: Response }> {
  const session = await getServerSession();
  if (!session) return { ok: false, response: denial("Unauthorized", 401) };
  if (!canOrg(session.user.role, perms)) {
    return { ok: false, response: denial("Forbidden", 403) };
  }
  return { ok: true, session };
}
