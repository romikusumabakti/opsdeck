import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "@/i18n/navigation";
import { auth } from "./auth";
import { db } from "./db";
import { environments, projectMembers } from "./db/schema";
import {
  type Capability,
  ROLE_ADMIN,
  ROLE_MEMBER,
  roleHasCapability,
  roleRank,
  type UserRole,
} from "./roles";

export async function getServerSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requireSession() {
  const session = await getServerSession();
  if (!session) {
    // Proxy only checks cookie presence; a stale cookie reaches here.
    // `redirect` is typed `void`, so throw to narrow the return type for
    // callers that read `session.user.*` directly afterwards.
    await redirect("/sign-in");
    throw new Error("redirect did not abort");
  }
  return session;
}

export function isAdmin(session: { user: { role?: string | null } }): boolean {
  return session.user.role === ROLE_ADMIN;
}

type SessionUser = { user: { id: string; role?: string | null } };

// Scope a capability check to a project. Ops actions (backups/databases/
// mock-time) act on an ENVIRONMENT, so they pass `{ environmentId }` and the
// resolver maps it up to its owning project. Pass `{ projectId }` when you
// already hold the logical project id. No scope = global role only.
type CapabilityScope = { projectId?: string; environmentId?: string };

// Effective role = the higher of the user's global role and their membership
// role on the scoped project. Unknown/legacy strings floor to viewer via
// roleRank, so a bad value can never grant more than the global role does.
async function resolveEffectiveRole(
  session: SessionUser,
  scope?: CapabilityScope
): Promise<string> {
  const globalRole = session.user.role ?? ROLE_MEMBER;
  if (!scope) return globalRole;

  let projectId = scope.projectId;
  if (!projectId && scope.environmentId) {
    const [env] = await db
      .select({ projectId: environments.projectId })
      .from(environments)
      .where(eq(environments.id, scope.environmentId))
      .limit(1);
    projectId = env?.projectId;
  }
  if (!projectId) return globalRole;

  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, session.user.id)
      )
    )
    .limit(1);
  if (!membership) return globalRole;

  return roleRank(membership.role) > roleRank(globalRole)
    ? membership.role
    : globalRole;
}

/**
 * Authorize the current user for a capability, optionally within a project or
 * environment scope. Unauthenticated users are sent to sign-in; authenticated
 * users lacking the capability are sent home (we don't reveal "forbidden" — the
 * UI already hides actions they can't take). Returns the session on success.
 */
export async function requireCapability(
  cap: Capability,
  scope?: CapabilityScope
) {
  const session = await requireSession();
  const role = await resolveEffectiveRole(session, scope);
  if (!roleHasCapability(role, cap)) {
    await redirect("/");
    throw new Error("redirect did not abort");
  }
  return session;
}

/**
 * The user's effective role for a scope, for the UI to gate button visibility.
 * Does not redirect — read it in a page/layout and pass it to client components.
 */
export async function getEffectiveRole(
  scope?: CapabilityScope
): Promise<UserRole> {
  const session = await requireSession();
  return (await resolveEffectiveRole(session, scope)) as UserRole;
}

/**
 * Require a global admin. Thin wrapper over `requireCapability("admin")` — the
 * `admin` capability's minimum role is `admin`, and only the global role can be
 * admin, so behavior matches the previous implementation. Kept as a named
 * helper because most admin-only call sites read better as `requireAdmin()`.
 */
export async function requireAdmin() {
  return requireCapability("admin");
}
