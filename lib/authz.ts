import type { AnyColumn, SQL } from "drizzle-orm";
import type { EmptyFilter } from "drizzle-orm/relations";
import {
  accessScopeFromSession,
  canAll,
  decideOrgAccess,
  ForbiddenError,
  getProjectAccess,
  type ProjectAccess,
  type ProjectTarget,
  projectIdOf,
  requireAnyProjectPermissionIn,
  requireProjectPermissionIn,
  resolveProjectAccess,
  roleOn,
  scopedProjectFilter,
  scopedProjectIds,
  scopedProjectIdsWhere,
} from "@/lib/access-scope";
import { getServerSession, requireSession } from "@/lib/auth-session";
import {
  canOrg,
  canOrgAccess,
  canOrgAccessTarget,
  canProject,
  normalizeOrgRole,
  type OrgPermissions,
  type OrgRole,
  type ProjectPermissions,
  type ProjectRole,
  requiresStrongSignIn,
} from "@/lib/permissions";
import {
  isStrongSignIn,
  STRONG_SIGN_IN_CODE,
  STRONG_SIGN_IN_MESSAGE,
} from "@/lib/sign-in-method";

export {
  ForbiddenError,
  getProjectAccess,
  type ProjectAccess,
  resolveProjectAccess,
};

// The server-side authorization boundary. lib/permissions says what each role
// may do; this module works out which roles the caller holds and enforces them.
//
// Denials: a project you can't see doesn't exist, so it is a 404; a visible
// project or an org-level action you may not perform is a 403 (the UI already
// hides what you can't do, so reaching one is a bug or a forged call). The
// require* guards throw, and server/errors turns the throw into the response;
// the route* guards return the Response for handlers that want to branch.

type Session = NonNullable<Awaited<ReturnType<typeof getServerSession>>>;

// Risky actions (terminal, files, secrets, admin) refuse a session that was
// not created by a passkey, Microsoft or password + TOTP.
export function assertStrongSession(session: Session): void {
  if (!isStrongSignIn(session.session.signInMethod)) {
    throw new ForbiddenError(STRONG_SIGN_IN_MESSAGE, STRONG_SIGN_IN_CODE);
  }
}

// For org-level rights checked on their own (an admin-only bypass or
// confirmation inside a project action) instead of through requireOrgPermission:
// canOrg, plus the strong sign-in any strong-only action needs.
export function orgGrantAllows(session: Session, perms: OrgPermissions) {
  return (
    canOrg(session.user.role, perms) &&
    (!requiresStrongSignIn(perms) ||
      isStrongSignIn(session.session.signInMethod))
  );
}

// The throwing form: the plain 403 when the role lacks the right, the coded
// one when only the sign-in is too weak (permission first, strength second).
export function requireOrgGrant(session: Session, perms: OrgPermissions): void {
  if (!canOrg(session.user.role, perms)) throw new ForbiddenError();
  if (requiresStrongSignIn(perms)) assertStrongSession(session);
}

// The org role to hand to helpers that decide an org grant from a role alone
// (canPlaceEnvironment, the shared-database confinement, the domain publish
// rule): a weak session holds none, so it gets the floor role.
export function orgGrantRole(session: Session): string | null | undefined {
  return isStrongSignIn(session.session.signInMethod)
    ? session.user.role
    : null;
}

// The session guards below are the access-scope helpers (lib/access-scope)
// applied to the signed-in caller's scope: one rule set for requests and for
// background reads that carry an explicit scope.

export type ProjectScope = ProjectTarget;

export async function getOrgRole(): Promise<OrgRole> {
  const session = await requireSession();
  return normalizeOrgRole(session.user.role);
}

export async function accessibleProjectIds(): Promise<"all" | string[]> {
  return scopedProjectIds(await accessScopeFromSession());
}

// SQL-builder filter for any column holding a project id (see
// lib/access-scope#scopedProjectFilter).
export async function projectScope(
  column: AnyColumn
): Promise<SQL | undefined> {
  return scopedProjectFilter(await accessScopeFromSession(), column);
}

// The same filter for drizzle's relational query API (RQB v2):
// `where: { projectId: await projectIdsWhere() }`.
export async function projectIdsWhere(): Promise<
  { in: string[] } | typeof EmptyFilter
> {
  return scopedProjectIdsWhere(await accessScopeFromSession());
}

export async function getProjectRole(
  scope: ProjectScope
): Promise<ProjectRole | null> {
  const projectId = await projectIdOf(scope);
  if (!projectId) return null;
  return roleOn(await accessScopeFromSession(), projectId);
}

// Org permission for the signed-in caller: their job role, plus the engineer
// grant (lib/permissions#canOrgAccess).
async function callerCanOrg(
  session: Session,
  perms: OrgPermissions
): Promise<boolean> {
  return canOrgAccess(session.user.role, perms);
}

// callerCanOrg for one target: a restricted one (an infra-only server, the
// instance backup bucket) takes the org role alone
// (lib/permissions#canOrgAccessTarget). An extra check after the central
// guard, for the routes that act on a single server or bucket.
export async function callerCanOrgTarget(
  session: Session,
  perms: OrgPermissions,
  restricted: boolean
): Promise<boolean> {
  return canOrgAccessTarget(session.user.role, perms, restricted);
}

export async function requireOrgPermission(
  perms: OrgPermissions
): Promise<Session> {
  const session = await requireSession();
  decideOrgAccess(
    session.user.role,
    perms,
    isStrongSignIn(session.session.signInMethod)
  );
  return session;
}

// The page guards predate the API: under Next they rendered the 404 page
// instead of throwing. An API has one way to deny, so they are now plain
// aliases, kept so their call sites (and the scope check in
// tests/authz-guards.test.ts) don't churn.
export const requireOrgPage = requireOrgPermission;

// The project role decides (lib/access-scope#requireProjectPermissionIn). An
// environment's owner (environments.owner_id) is a label and gets no rights
// from it.
export async function requireProjectPermission(
  scope: ProjectScope,
  perms: ProjectPermissions
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const session = await requireSession();
  return {
    session,
    ...(await requireProjectPermissionIn(
      await accessScopeFromSession(),
      scope,
      perms
    )),
  };
}

// Like requireProjectPermission, but one of several alternative requests is
// enough (e.g. a listing that backup or restore roles may both read).
export async function requireAnyProjectPermission(
  scope: ProjectScope,
  alternatives: ProjectPermissions[]
): Promise<{ session: Session; role: ProjectRole; projectId: string }> {
  const session = await requireSession();
  return {
    session,
    ...(await requireAnyProjectPermissionIn(
      await accessScopeFromSession(),
      scope,
      alternatives
    )),
  };
}

// Alias of requireProjectPermission (see requireOrgPage), defaulting to the
// read access a page needs.
export function requireProjectPage(
  scope: ProjectScope,
  perms: ProjectPermissions = { project: ["read"] }
): ReturnType<typeof requireProjectPermission> {
  return requireProjectPermission(scope, perms);
}

export async function requireProjectPermissionForAll(
  projectIds: string[],
  perms: ProjectPermissions
): Promise<Session> {
  const session = await requireSession();
  const scope = await accessScopeFromSession();
  if (!canAll(scope, [...new Set(projectIds)], perms)) {
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
  if (!(await callerCanOrg(session, perms))) {
    return { ok: false, response: denial("Forbidden", 403) };
  }
  if (
    requiresStrongSignIn(perms) &&
    !isStrongSignIn(session.session.signInMethod)
  ) {
    return {
      ok: false,
      response: Response.json(
        { error: STRONG_SIGN_IN_MESSAGE, code: STRONG_SIGN_IN_CODE },
        { status: 403 }
      ),
    };
  }
  return { ok: true, session };
}
