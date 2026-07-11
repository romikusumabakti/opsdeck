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
export function roleRank(role: string | null | undefined): number {
  return ROLE_RANK[(role ?? "") as UserRole] ?? 0;
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
