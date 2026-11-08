import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission, requireProjectPermission } from "@/lib/authz";
import {
  canLock,
  canUnlock,
  defaultLockExpiry,
  isLockActive,
  lockExpirySchema,
  lockReasonSchema,
} from "@/lib/deploy/lock";
import { releaseLock } from "@/lib/deploy/lock-release";
import {
  countHeldDeployments,
  type DeployLockWithLocker,
  getDeployLock,
  getEnvironmentForLock,
  insertDeployLock,
  updateDeployLock,
} from "@/lib/deploy/repository";
import { badRequest, forbidden, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// The environment's deploy lock. Who may do what (lib/deploy/lock):
// - lock: the environment's owner (any project role) and project engineers;
// - unlock: whoever set the lock and the environment's owner — not other
//   engineers;
// - force-unlock, with a reason: org admins (integration:manage).
// Ownership is read on every request, so a former owner loses lock rights at
// once; a lock they set stays until it is unlocked or expires.

export type DeployLockState = {
  lock: {
    lockedBy: { id: string; name: string } | null;
    reason: string;
    expiresAt: Date;
  } | null;
  heldCount: number;
};

/** The translated 409 text for a request refused by an active lock. */
export async function deployLockedMessage(
  lock: Pick<DeployLockWithLocker, "lockerName" | "reason" | "expiresAt">
): Promise<string> {
  const t = await getServerTranslator("actionErrors");
  return t("deployLocked", {
    name: lock.lockerName ?? t("deployLockHolderUnknown"),
    reason: lock.reason,
    expiresAt: lock.expiresAt,
  });
}

/**
 * Refuses a manual deploy or rollback early, with the lock's details, when the
 * environment is locked. requestDeployment decides again inside its
 * transaction; this only spares the work before it.
 */
export async function assertNotDeployLocked(
  environmentId: string
): Promise<void> {
  const lock = await getDeployLock(environmentId);
  if (lock && isLockActive(lock, new Date())) {
    throw new HTTPException(409, { message: await deployLockedMessage(lock) });
  }
}

async function lockContext(environmentId: string) {
  // At least `viewer` on the project: without it the environment is a 404.
  const { session, role } = await requireProjectPermission(
    { environmentId },
    { deploy: ["view"] }
  );
  const environment =
    (await getEnvironmentForLock(environmentId)) ?? notFound();
  const userId = session.user.id;
  return {
    userId,
    role,
    environment,
    isOwner: environment.ownerId !== null && environment.ownerId === userId,
  };
}

async function readState(
  environmentId: string,
  now: Date
): Promise<DeployLockState> {
  const [lock, heldCount] = await Promise.all([
    getDeployLock(environmentId),
    countHeldDeployments(environmentId),
  ]);
  if (!lock || !isLockActive(lock, now)) {
    return { lock: null, heldCount };
  }
  return {
    lock: {
      lockedBy: lock.lockedBy
        ? { id: lock.lockedBy, name: lock.lockerName ?? "" }
        : null,
      reason: lock.reason,
      expiresAt: lock.expiresAt,
    },
    heldCount,
  };
}

export async function getDeployLockState(
  environmentId: string
): Promise<DeployLockState> {
  await requireProjectPermission({ environmentId }, { deploy: ["view"] });
  return readState(environmentId, new Date());
}

/**
 * Locks the environment's deploys, or changes the reason and expiry of a lock
 * the caller may unlock. The expiry defaults to 17:00 Asia/Jakarta (now + 2 h
 * after 16:00), at most 7 days ahead. An expired lock still in place is
 * released first, so its held builds deploy as they would have on the sweep.
 */
export async function lockEnvironment(
  environmentId: string,
  input: { reason?: string; expiresAt?: string }
): Promise<DeployLockState> {
  const { userId, role, environment, isOwner } =
    await lockContext(environmentId);
  if (!canLock(role, isOwner)) forbidden();

  const t = await getServerTranslator("actionErrors");
  const reason = lockReasonSchema.safeParse(input.reason);
  if (!reason.success) badRequest(t("deployLockReasonInvalid"));
  const now = new Date();
  let expiresAt = defaultLockExpiry(now);
  if (input.expiresAt !== undefined) {
    const parsed = lockExpirySchema.safeParse(input.expiresAt);
    if (!parsed.success) badRequest(t("deployLockExpiryInvalid"));
    expiresAt = parsed.data;
  }
  const lock = { reason: reason.data, expiresAt };

  let action = "deployLock.locked";
  const existing = await getDeployLock(environmentId);
  if (existing && isLockActive(existing, now)) {
    if (!canUnlock(isOwner, existing.lockedBy === userId)) {
      throw new HTTPException(409, {
        message: await deployLockedMessage(existing),
      });
    }
    if (!(await updateDeployLock(environmentId, existing.createdAt, lock))) {
      throw new HTTPException(409, { message: t("deployLockChanged") });
    }
    action = "deployLock.updated";
  } else {
    if (existing) {
      await releaseLock(environmentId, "expired", null, {
        expectedCreatedAt: existing.createdAt,
        now,
      });
    }
    const inserted = await insertDeployLock({
      environmentId,
      lockedBy: userId,
      ...lock,
      createdAt: now,
    });
    if (!inserted) {
      const current = await getDeployLock(environmentId);
      throw new HTTPException(409, {
        message: current
          ? await deployLockedMessage(current)
          : t("deployLockChanged"),
      });
    }
  }

  await recordActivity({
    actorId: userId,
    action,
    entityType: "environment",
    entityId: environmentId,
    data: {
      environment: environment.name,
      reason: lock.reason,
      expiresAt: lock.expiresAt.toISOString(),
    },
  });
  return readState(environmentId, now);
}

/**
 * Removes the lock — only whoever set it, or the environment's owner — and
 * queues the newest held build of each target. No lock: nothing to do. A lock
 * past its expiry that the sweep has not removed yet no longer binds anyone:
 * any project member clearing it releases it as expired.
 */
export async function unlockEnvironment(
  environmentId: string
): Promise<{ queued: string[] }> {
  const { userId, isOwner } = await lockContext(environmentId);
  const lock = await getDeployLock(environmentId);
  if (!lock) return { queued: [] };
  const now = new Date();
  if (!isLockActive(lock, now)) {
    const { released, queued } = await releaseLock(
      environmentId,
      "expired",
      null,
      { expectedCreatedAt: lock.createdAt, now }
    );
    if (!released) await assertLockUnchanged(environmentId);
    return { queued };
  }
  if (!canUnlock(isOwner, lock.lockedBy === userId)) forbidden();
  const { released, queued } = await releaseLock(
    environmentId,
    "unlock",
    userId,
    { expectedCreatedAt: lock.createdAt }
  );
  if (!released) await assertLockUnchanged(environmentId);
  return { queued };
}

/**
 * After a conditional release matched nothing: 409 when a lock is in place —
 * the one checked was replaced by another before the delete, and the caller's
 * right to remove the new one was never checked. No lock at all (a concurrent
 * unlock or the sweep removed it) is fine.
 */
async function assertLockUnchanged(environmentId: string): Promise<void> {
  if (await getDeployLock(environmentId)) {
    const t = await getServerTranslator("actionErrors");
    throw new HTTPException(409, { message: t("deployLockChanged") });
  }
}

/** An org admin removes someone's lock; the reason goes to the activity log. */
export async function forceUnlockEnvironment(
  environmentId: string,
  input: { reason?: string }
): Promise<{ queued: string[] }> {
  const session = await requireOrgPermission({ integration: ["manage"] });
  const t = await getServerTranslator("actionErrors");
  const reason = lockReasonSchema.safeParse(input.reason);
  if (!reason.success) badRequest(t("deployForceUnlockReasonRequired"));
  if (!(await getEnvironmentForLock(environmentId))) notFound();
  const { queued } = await releaseLock(
    environmentId,
    "force",
    session.user.id,
    {
      reason: reason.data,
    }
  );
  return { queued };
}
