import type { QueryClient } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import {
  canOrg,
  canProject,
  type OrgPermissions,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";
import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";

/**
 * The caller's role on a project, from the access map the app shell already
 * loads. Null when the project is invisible to them.
 */
export async function projectRoleOf(
  queryClient: QueryClient,
  projectId: string
): Promise<ProjectRole | null> {
  const access = await queryClient.query(getMyProjectAccessQuery());
  return access.roles[projectId] ?? null;
}

/**
 * The page guard for a project page (the port of `requireProjectPage`): a 404
 * when the project is invisible or the role lacks `perms`, and, when `orgPerms`
 * is given, the org role must allow those too. The server enforces the same
 * rules on every endpoint; this keeps the page from rendering a form the
 * caller cannot use.
 */
export async function requireProjectRole(
  queryClient: QueryClient,
  projectId: string,
  perms: ProjectPermissions = { project: ["read"] },
  orgPerms?: OrgPermissions
): Promise<ProjectRole> {
  const role = await projectRoleOf(queryClient, projectId);
  if (!(role && canProject(role, perms))) throw notFound();
  if (orgPerms) {
    const me = await queryClient.query(meQuery());
    if (!canOrg(me?.orgRole, orgPerms)) throw notFound();
  }
  return role;
}

/**
 * The same page guard for a role already in hand (the environment layout puts
 * the caller's role in the route context): a 404 when it lacks `perms`.
 */
export function requireRole(
  role: ProjectRole,
  perms: ProjectPermissions
): void {
  if (!canProject(role, perms)) throw notFound();
}
