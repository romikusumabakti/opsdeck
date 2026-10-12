// Pure rules behind user and access management, kept apart so they're testable
// without a DB. Client-safe: the users page filters and labels rows with these.

const DAY_MS = 24 * 60 * 60 * 1000;

// True when changing `targetId` to `nextRole` (null = offboard) still leaves at
// least one admin. Without an admin nobody can manage users or roles.
export function assertNotLastAdmin(
  adminIds: string[],
  targetId: string,
  nextRole: string | null
): boolean {
  if (!adminIds.includes(targetId)) return true;
  if (nextRole === "admin") return true;
  return adminIds.some((id) => id !== targetId);
}

export function isInactive(
  lastSeen: Date | null,
  now: Date,
  days = 60
): boolean {
  if (!lastSeen) return true;
  return now.getTime() - lastSeen.getTime() > days * DAY_MS;
}

// The fields the users page needs to classify a row. `lastActiveAt` may arrive
// as a Date (server) or an ISO string (serialized), so both are accepted.
export type UserActivity = {
  banned: boolean;
  lastActiveAt: Date | string | null;
};

function lastActive(u: UserActivity): Date | null {
  return u.lastActiveAt ? new Date(u.lastActiveAt) : null;
}

export type UserStatus = "active" | "inactive" | "banned";

// One status per user for badges: banned outranks inactive, since a banned
// account can't sign in and its idleness says nothing.
export function userStatus(u: UserActivity, now: Date): UserStatus {
  if (u.banned) return "banned";
  return isInactive(lastActive(u), now) ? "inactive" : "active";
}

// The users page filters: banned rows stay hidden unless asked for, and
// `inactiveOnly` keeps users idle for more than 60 days (banned or not).
export function filterUsers<T extends UserActivity>(
  users: readonly T[],
  opts: { showBanned: boolean; inactiveOnly: boolean; now: Date }
): T[] {
  return users.filter(
    (u) =>
      (opts.showBanned || !u.banned) &&
      (!opts.inactiveOnly || isInactive(lastActive(u), opts.now))
  );
}

export const USERS_TABS = ["users", "access", "pending", "expired"] as const;
export type UsersTab = (typeof USERS_TABS)[number];

// Resolve `?tab=` against the tabs this viewer can see; anything else (absent,
// unknown, or hidden by permission or emptiness) lands on the users list.
export function parseUsersTab(
  raw: string | null | undefined,
  visible: readonly UsersTab[]
): UsersTab {
  return visible.find((tab) => tab === raw) ?? "users";
}
