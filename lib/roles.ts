// Role constants kept in their own module so client components can import
// them without pulling in `lib/auth.ts` (which transitively imports the
// postgres driver — a server-only dependency). Everything here is pure and
// client-safe: the capability helpers gate button visibility in the browser
// and authorize actions on the server from the same source of truth.

export const ROLE_VIEWER = "viewer";
export const ROLE_MEMBER = "member";
export const ROLE_MAINTAINER = "maintainer";
export const ROLE_ADMIN = "admin";

export type UserRole =
  | typeof ROLE_VIEWER
  | typeof ROLE_MEMBER
  | typeof ROLE_MAINTAINER
  | typeof ROLE_ADMIN;

// Every role an admin may move an existing user to, low → high. Shared by the
// Users page menu and the server action behind it so they can't drift. Wider
// than the invitation form's choices because `viewer` is where Microsoft
// sign-in drops self-provisioned users and has to be reachable both ways.
export const ASSIGNABLE_ROLES: readonly UserRole[] = [
  ROLE_VIEWER,
  ROLE_MEMBER,
  ROLE_MAINTAINER,
  ROLE_ADMIN,
] as const;

export function isAssignableRole(role: string): role is UserRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

// Capability ladder, low → high. Comparison is by rank so "effective role"
// (max of global + per-project membership) resolves with a single number.
export const ROLE_RANK: Record<UserRole, number> = {
  [ROLE_VIEWER]: 0,
  [ROLE_MEMBER]: 1,
  [ROLE_MAINTAINER]: 2,
  [ROLE_ADMIN]: 3,
};

// Unknown / null / legacy role strings floor to viewer (safe-deny) rather than
// throwing, so a stale role value can never accidentally grant more than read.
//
// Goes through normalizeRole rather than indexing ROLE_RANK directly: a plain
// object literal inherits Object.prototype, so `ROLE_RANK["toString"]` used to
// return a *function* — truthy, so the `?? 0` fallback never fired and this
// returned a non-number. It failed closed (a function compares false against
// every rank), but the contract was still a lie. normalizeRole tests
// membership against the ASSIGNABLE_ROLES array, which has no such holes.
export function roleRank(role: string | null | undefined): number {
  return ROLE_RANK[normalizeRole(role)];
}

// Narrow an arbitrary stored string to a real role, flooring anything unknown
// to viewer. Same safe-deny rule as roleRank, but returning the role itself so
// callers can hand a UserRole onward without an unchecked cast.
export function normalizeRole(role: string | null | undefined): UserRole {
  const value = role ?? "";
  return isAssignableRole(value) ? value : ROLE_VIEWER;
}

/**
 * The higher-ranked of two roles — how a user's global role and their
 * membership role on one project combine into the role that actually applies
 * there. Extracted from lib/auth-session so the rule is unit-testable without
 * a database: it decides every authorization outcome in the app.
 *
 * Ties return the first argument, which is the same role by rank either way.
 */
export function higherRole(
  a: string | null | undefined,
  b: string | null | undefined
): UserRole {
  const left = normalizeRole(a);
  const right = normalizeRole(b);
  return ROLE_RANK[left] >= ROLE_RANK[right] ? left : right;
}

// The actions a role may perform. Deliberately coarse — a static map, not a
// per-permission matrix builder (see docs/rework-plan.md anti-overengineering).
//   read             — view issues, knowledge, dashboards
//   issue.edit       — create/edit issues
//   kb.edit          — create/edit knowledge documents
//   ops.destructive  — backup/restore/create/drop DB, mock time
//   admin            — servers, storage, users, project CRUD, membership
export const CAPABILITIES = [
  "read",
  "issue.edit",
  "kb.edit",
  "ops.destructive",
  "admin",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_MIN_ROLE: Record<Capability, UserRole> = {
  read: ROLE_VIEWER,
  "issue.edit": ROLE_MEMBER,
  "kb.edit": ROLE_MEMBER,
  "ops.destructive": ROLE_MAINTAINER,
  admin: ROLE_ADMIN,
};

// True when `role` sits at or above the minimum rank a capability requires.
export function roleHasCapability(
  role: string | null | undefined,
  cap: Capability
): boolean {
  return roleRank(role) >= ROLE_RANK[CAPABILITY_MIN_ROLE[cap]];
}
