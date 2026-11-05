import { z } from "zod";
import type { ProjectRole } from "@/lib/permissions";

const HOUR_MS = 3_600_000;
// Asia/Jakarta is UTC+7 all year (no DST), so a fixed offset is exact and
// independent of the host timezone.
const JAKARTA_OFFSET_MS = 7 * HOUR_MS;
const MAX_LOCK_MS = 7 * 24 * HOUR_MS;

export const LOCK_REASON_MAX = 200;

// 17:00 Asia/Jakarta today; now + 2 h once it is already past 16:00 there.
export function defaultLockExpiry(now: Date): Date {
  const jakarta = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const minutesOfDay = jakarta.getUTCHours() * 60 + jakarta.getUTCMinutes();
  const afterFour =
    minutesOfDay > 16 * 60 ||
    (minutesOfDay === 16 * 60 &&
      jakarta.getUTCSeconds() + jakarta.getUTCMilliseconds() > 0);
  if (afterFour) {
    return new Date(now.getTime() + 2 * HOUR_MS);
  }
  return new Date(
    Date.UTC(
      jakarta.getUTCFullYear(),
      jakarta.getUTCMonth(),
      jakarta.getUTCDate(),
      17
    ) - JAKARTA_OFFSET_MS
  );
}

// Must be in the future and at most 7 days ahead, judged at parse time.
export const lockExpirySchema = z.coerce.date().refine(
  (date) => {
    const now = Date.now();
    return date.getTime() > now && date.getTime() <= now + MAX_LOCK_MS;
  },
  { message: "Expiry must be in the future and within 7 days" }
);

export const lockReasonSchema = z.string().trim().min(1).max(LOCK_REASON_MAX);

// An expired lock no longer blocks, even before the sweep deletes it.
export function isLockActive(
  lock: { expiresAt: Date } | null,
  now: Date
): boolean {
  return lock !== null && lock.expiresAt.getTime() > now.getTime();
}

// The environment owner (any project role) and project maintainers.
export function canLock(role: ProjectRole | null, isOwner: boolean): boolean {
  if (role === null) {
    return false;
  }
  return isOwner || role === "maintainer";
}

// Only the owner and whoever set the lock; maintainers cannot unlock others'.
export function canUnlock(isOwner: boolean, isLocker: boolean): boolean {
  return isOwner || isLocker;
}

// The buttons on an active lock's banner. Changing the lock is a PUT, which
// needs the right to lock as well as the right to remove this lock: a former
// owner who set it may still unlock it, but not change it. Force unlock is
// offered only to an admin who may not simply unlock.
export function lockBannerActions(rights: {
  mayLock: boolean;
  mayUnlock: boolean;
  mayForce: boolean;
}): { unlock: boolean; force: boolean; edit: boolean } {
  return {
    unlock: rights.mayUnlock,
    force: rights.mayForce && !rights.mayUnlock,
    edit: rights.mayUnlock && rights.mayLock,
  };
}

export type Placement = "queued" | "held" | "locked";

// What a deploy request does under the environment's lock: without an active
// lock everything queues; while locked an auto deploy is held (it deploys on
// release) and a manual deploy or rollback is refused.
export function placementFor(
  lock: { expiresAt: Date } | null,
  trigger: "auto" | "manual" | "rollback",
  now: Date
): Placement {
  if (!isLockActive(lock, now)) {
    return "queued";
  }
  return trigger === "auto" ? "held" : "locked";
}

type HeldRow = { id: string; targetId: string; createdAt: Date };

// On release, per target the newest held deployment deploys and the older ones
// are superseded. Newest by creation time, then by id (uuidv7, so a later
// insert in the same instant still sorts after an earlier one).
export function planHeldRelease(rows: HeldRow[]): {
  queue: string[];
  supersede: string[];
} {
  const newest = new Map<string, HeldRow>();
  for (const row of rows) {
    const current = newest.get(row.targetId);
    if (!current || isNewer(row, current)) {
      newest.set(row.targetId, row);
    }
  }
  const queue = new Set([...newest.values()].map((row) => row.id));
  return {
    queue: rows.filter((row) => queue.has(row.id)).map((row) => row.id),
    supersede: rows.filter((row) => !queue.has(row.id)).map((row) => row.id),
  };
}

function isNewer(a: HeldRow, b: HeldRow): boolean {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  return diff > 0 || (diff === 0 && a.id > b.id);
}
