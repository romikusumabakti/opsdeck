// Pure rules behind the access page, kept apart so they're testable without a DB.

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
