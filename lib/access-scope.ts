import { type AnyColumn, eq, inArray, type SQL, sql } from "drizzle-orm";
import { EmptyFilter } from "drizzle-orm/relations";
import { HTTPException } from "hono/http-exception";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  environments,
  issues,
  projectMembers,
  projects,
} from "@/lib/db/schema";
import {
  canAnyProject,
  canProject,
  effectiveProjectRole,
  normalizeOrgRole,
  type OrgRole,
  type ProjectPermissions,
  type ProjectRole,
  seesAllProjects,
} from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";
import { requestCache } from "@/server/context";
import { notFound } from "@/server/errors";

// Who the caller is and which project roles they hold, as a value. Reads take
// one, so the same rules decide for a request (accessScopeFromSession) and for
// background code with no request session, such as the assistant worker
// (accessScopeForUser). lib/authz builds its session guards on these helpers;
// lib/permissions stays the table of what each role may do.
//
// Denials match lib/authz: a project you can't see doesn't exist (404); a
// visible project where the action is not permitted is a 403.

export type AccessScope = {
  userId: string;
  orgRole: OrgRole;
  /** The statement set held on each visible project; absent = invisible. */
  projectRoles: Record<string, ProjectRole>;
  /** True when the job role sees every project (list queries skip the filter). */
  seesAllProjects: boolean;
};

export type ProjectAccess = {
  all: boolean;
  roles: Record<string, ProjectRole>;
};

/** What a project-scoped check names: the project, or a row that belongs to one. */
export type ProjectTarget =
  | { projectId: string }
  | { environmentId: string }
  | { issueId: string };

// An HTTPException, so the app's onError answers it with a 403. Kept as its own
// class so callers can still tell a denial apart from any other failure.
// `code`, when set, names the rule that refused (see server/errors#errorCode).
export class ForbiddenError extends HTTPException {
  constructor(
    message = "Forbidden",
    readonly code?: string
  ) {
    super(403, { message });
    this.name = "ForbiddenError";
  }
}

/** accessScopeForUser: the user has no row, or a ban is in force (no session either way). */
export class AccessScopeError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "banned"
  ) {
    super(message);
    this.name = "AccessScopeError";
  }
}

// Pure: combine the job role and the caller's memberships into the statement
// set per visible project. `all` is true when the role sees every project, so
// list queries can skip the filter.
export function resolveProjectAccess(
  orgRole: string | null | undefined,
  allProjectIds: string[],
  memberProjectIds: readonly string[]
): ProjectAccess {
  const all = seesAllProjects(orgRole);
  const memberSet = new Set(memberProjectIds);
  const roles: Record<string, ProjectRole> = {};
  const candidates = all ? allProjectIds : memberSet;
  for (const projectId of candidates) {
    const role = effectiveProjectRole(orgRole, memberSet.has(projectId));
    if (role) roles[projectId] = role;
  }
  return { all, roles };
}

/** Pure: the scope for a user (id, stored role) holding `access`. */
function scopeFromAccess(
  user: { id: string; role?: string | null },
  access: ProjectAccess
): AccessScope {
  return {
    userId: user.id,
    orgRole: normalizeOrgRole(user.role),
    projectRoles: access.roles,
    seesAllProjects: access.all,
  };
}

// The signed-in caller's project access, once per request.
export const getProjectAccess = requestCache(
  async (): Promise<ProjectAccess> => {
    const session = await requireSession();
    const [allProjects, memberships] = await Promise.all([
      db.select({ id: projects.id }).from(projects),
      db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, session.user.id)),
    ]);
    return resolveProjectAccess(
      session.user.role,
      allProjects.map((p) => p.id),
      memberships.map((m) => m.projectId)
    );
  }
);

/** The signed-in caller's scope; a 401 without a session. */
export async function accessScopeFromSession(): Promise<AccessScope> {
  const session = await requireSession();
  return scopeFromAccess(session.user, await getProjectAccess());
}

/** A ban without an expiry, or one that has not expired yet, is in force. */
function isBanned(user: {
  banned: boolean | null;
  banExpires: Date | null;
}): boolean {
  if (!user.banned) return false;
  return user.banExpires === null || user.banExpires.getTime() > Date.now();
}

/**
 * The scope of a user by id, from their row and memberships: the rules of
 * accessScopeFromSession without a request. An unknown or banned user, who
 * could hold no session, is refused with AccessScopeError.
 */
export async function accessScopeForUser(userId: string): Promise<AccessScope> {
  const user = await db.query.users.findFirst({
    where: { id: userId },
    columns: { id: true, role: true, banned: true, banExpires: true },
  });
  if (!user) throw new AccessScopeError("User not found", "not_found");
  if (isBanned(user)) throw new AccessScopeError("User is banned", "banned");
  const [allProjects, memberships] = await Promise.all([
    db.query.projects.findMany({ columns: { id: true } }),
    db.query.projectMembers.findMany({
      where: { userId },
      columns: { projectId: true },
    }),
  ]);
  return scopeFromAccess(
    user,
    resolveProjectAccess(
      user.role,
      allProjects.map((p) => p.id),
      memberships.map((m) => m.projectId)
    )
  );
}

/** The scope's role on a project; null = the project is invisible. */
export function roleOn(
  scope: AccessScope,
  projectId: string | null
): ProjectRole | null {
  return projectId ? (scope.projectRoles[projectId] ?? null) : null;
}

/** Does the scope grant `perms` on the project? An invisible project fails. */
export function can(
  scope: AccessScope,
  projectId: string,
  perms: ProjectPermissions
): boolean {
  return canProject(roleOn(scope, projectId), perms);
}

/** Does every project in the set grant `perms`? An invisible project fails. */
export function canAll(
  scope: AccessScope,
  projectIds: readonly string[],
  perms: ProjectPermissions
): boolean {
  return projectIds.every((id) => can(scope, id, perms));
}

/** The visible project ids, or "all" when the role sees every project. */
export function scopedProjectIds(scope: AccessScope): "all" | string[] {
  return scope.seesAllProjects ? "all" : Object.keys(scope.projectRoles);
}

// SQL-builder filter for any column holding a project id. Undefined = no filter
// (drizzle's and() drops it); an empty set becomes `false`, never `IN ()`.
export function scopedProjectFilter(
  scope: AccessScope,
  column: AnyColumn
): SQL | undefined {
  const ids = scopedProjectIds(scope);
  if (ids === "all") return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(column, ids);
}

// The same filter for drizzle's relational query API (RQB v2):
// `where: { projectId: scopedProjectIdsWhere(scope) }`. EmptyFilter = no filter
// (RQB throws on `undefined`, and skips a relation filter holding only
// EmptyFilter); `{ in: [] }` matches nothing.
export function scopedProjectIdsWhere(
  scope: AccessScope
): { in: string[] } | typeof EmptyFilter {
  const ids = scopedProjectIds(scope);
  return ids === "all" ? EmptyFilter : { in: ids };
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
export async function projectIdOf(
  target: ProjectTarget
): Promise<string | null> {
  if ("projectId" in target) {
    return uuidSchema.safeParse(target.projectId).success
      ? target.projectId
      : null;
  }
  if ("environmentId" in target) {
    return uuidSchema.safeParse(target.environmentId).success
      ? projectIdOfEnvironment(target.environmentId)
      : null;
  }
  return uuidSchema.safeParse(target.issueId).success
    ? projectIdOfIssue(target.issueId)
    : null;
}

/** The scope's role on the target's project; null = invisible or missing. */
export async function projectRoleIn(
  scope: AccessScope,
  target: ProjectTarget
): Promise<ProjectRole | null> {
  const projectId = await projectIdOf(target);
  return roleOn(scope, projectId);
}

/**
 * The one project decision: 404 when the project is missing or invisible,
 * 403 when `allowed` refuses the role. lib/authz's guards reach it through
 * the two require*In helpers below.
 */
function decideProjectAccess(
  projectId: string | null,
  role: ProjectRole | null,
  allowed: (role: ProjectRole) => boolean
): { role: ProjectRole; projectId: string } {
  if (!projectId || !role) notFound();
  if (!allowed(role)) throw new ForbiddenError();
  return { role, projectId };
}

// The project role decides. An environment's owner (environments.owner_id)
// is a label and gets no rights from it.
export async function requireProjectPermissionIn(
  scope: AccessScope,
  target: ProjectTarget,
  perms: ProjectPermissions
): Promise<{ role: ProjectRole; projectId: string }> {
  const projectId = await projectIdOf(target);
  return decideProjectAccess(projectId, roleOn(scope, projectId), (role) =>
    canProject(role, perms)
  );
}

// Like requireProjectPermissionIn, but one of several alternative requests is
// enough (e.g. a listing that backup or restore roles may both read).
export async function requireAnyProjectPermissionIn(
  scope: AccessScope,
  target: ProjectTarget,
  alternatives: ProjectPermissions[]
): Promise<{ role: ProjectRole; projectId: string }> {
  const projectId = await projectIdOf(target);
  return decideProjectAccess(projectId, roleOn(scope, projectId), (role) =>
    canAnyProject(role, alternatives)
  );
}
