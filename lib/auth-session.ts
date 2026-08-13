import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "@/i18n/navigation";
import { auth } from "./auth";
import { db } from "./db";
import { environments, projectMembers } from "./db/schema";
import {
  type Capability,
  higherRole,
  normalizeRole,
  ROLE_ADMIN,
  ROLE_MEMBER,
  roleHasCapability,
  type UserRole,
} from "./roles";

/**
 * The current session, memoized for the lifetime of one request.
 *
 * `auth.api.getSession` re-parses the cookie and re-reads the `sessions` row on
 * every call, and this is called from ~180 sites — a single page render fans out
 * through the layout, its nested layouts, and every server action or data
 * helper it awaits, each of which calls `requireSession()` on its own. Without
 * this wrapper that is a fresh round-trip per call for an answer that cannot
 * change mid-request. React's `cache` scopes the memo to the request, so
 * concurrent requests never share a session.
 *
 * NOT the same thing as better-auth's `session.cookieCache`, which is
 * deliberately left off: that caches across requests in a signed cookie, so a
 * revoked session (account > sessions) or a ban would keep working until the
 * cookie's TTL expired. This wrapper has no such window.
 */
export const getServerSession = cache(async () => {
  return auth.api.getSession({
    headers: await headers(),
  });
});

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

// Both lookups below are memoized per request for the same reason
// `getServerSession` is: a page that calls `requireCapability` to gate the
// render and then `getEffectiveRole` to gate the buttons asks the identical
// question twice, and nested layouts multiply that. Keyed on primitives, so
// React's argument comparison actually hits — do NOT fold these back into
// `resolveEffectiveRole`, whose object argument would never match by identity.
const projectIdOfEnvironment = cache(async (environmentId: string) => {
  const [env] = await db
    .select({ projectId: environments.projectId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return env?.projectId;
});

const membershipRoleOf = cache(async (projectId: string, userId: string) => {
  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      )
    )
    .limit(1);
  return membership?.role;
});

// Effective role = the higher of the user's global role and their membership
// role on the scoped project. Unknown/legacy strings floor to viewer via
// normalizeRole, so a bad value can never grant more than the global role does.
// The combining rule itself lives in lib/roles (higherRole) so it can be tested
// without a database; everything here is the lookup around it.
async function resolveEffectiveRole(
  session: SessionUser,
  scope?: CapabilityScope
): Promise<UserRole> {
  // A user row with no role predates the admin plugin's defaultRole, so treat
  // it as `member` — not viewer — to match how those accounts already behave.
  const globalRole = normalizeRole(session.user.role ?? ROLE_MEMBER);
  if (!scope) return globalRole;

  let projectId = scope.projectId;
  if (!projectId && scope.environmentId) {
    projectId = await projectIdOfEnvironment(scope.environmentId);
  }
  if (!projectId) return globalRole;

  const membershipRole = await membershipRoleOf(projectId, session.user.id);
  if (!membershipRole) return globalRole;

  return higherRole(membershipRole, globalRole);
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
  return resolveEffectiveRole(session, scope);
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
