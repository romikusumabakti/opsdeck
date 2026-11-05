import { recordActivity } from "@/lib/activity";
import {
  getEnvironmentForLock,
  listExpiredDeployLocks,
  type ReleasedLock,
  releaseDeployLock,
} from "@/lib/deploy/repository";
import { enqueue } from "@/lib/queue";

export type ReleaseCause = "unlock" | "force" | "expired";

const ACTIONS: Record<ReleaseCause, string> = {
  unlock: "deployLock.unlocked",
  force: "deployLock.forceUnlocked",
  expired: "deployLock.expired",
};

/**
 * Releases the environment's deploy lock: deletes it and, per target, queues
 * the newest held deployment (older held ones are superseded), then enqueues
 * the queued ones and records an activity entry.
 *
 * Idempotent and safe under concurrency: the delete and the status changes are
 * one transaction (releaseDeployLock), so of two concurrent releases — two
 * unlocks, or an unlock and the sweep — only the first finds a lock and queues
 * anything; the other returns `{ released: false, queued: [] }` and records
 * nothing.
 *
 * The queued deployments are only enqueued: the worker claims them one at a
 * time, as for any deploy (one running deployment per environment).
 *
 * - `expectedCreatedAt`: release only the lock the caller checked, not one set
 *   since then.
 * - `now`: with cause `expired`, release only a lock expired by then.
 * - `reason`: the force-unlock reason, for the activity entry.
 *
 * The runs of the queued deployments belong to the actor for an unlock or a
 * force-unlock, and to nobody for an expiry.
 */
export async function releaseLock(
  environmentId: string,
  cause: ReleaseCause,
  actorId: string | null,
  options: { reason?: string; expectedCreatedAt?: Date; now?: Date } = {}
): Promise<{ released: boolean; queued: string[] }> {
  const released = await releaseDeployLock(
    environmentId,
    {
      createdAt: options.expectedCreatedAt,
      expiredAt: cause === "expired" ? (options.now ?? new Date()) : undefined,
    },
    cause === "expired" ? null : actorId
  );
  if (!released) return { released: false, queued: [] };
  const queued = await announceRelease(
    environmentId,
    cause,
    actorId,
    released,
    options.reason
  );
  return { released: true, queued };
}

/**
 * What follows a committed release: enqueue the queued deployments (in
 * order) and record the activity entry. Also used by requestDeployment for an
 * expired lock that placeDeployment released in its own transaction. Returns
 * the queued deployment ids.
 */
export async function announceRelease(
  environmentId: string,
  cause: ReleaseCause,
  actorId: string | null,
  released: ReleasedLock,
  reason?: string
): Promise<string[]> {
  for (const job of released.queued) {
    try {
      await enqueue("deploy/run.requested", job);
    } catch (error) {
      // The lock is gone and the row is queued; a failed enqueue leaves it
      // for an operator, like a failed enqueue in requestDeployment.
      console.error(
        `Failed to enqueue released deployment ${job.deploymentId}:`,
        error
      );
    }
  }

  const environment = await getEnvironmentForLock(environmentId);
  await recordActivity({
    actorId,
    action: ACTIONS[cause],
    entityType: "environment",
    entityId: environmentId,
    data: {
      environment: environment?.name ?? environmentId,
      ...(cause === "force"
        ? { reason: reason ?? "", lockReason: released.lock.reason }
        : { reason: released.lock.reason }),
      count: released.queued.length,
    },
  });
  return released.queued.map((job) => job.deploymentId);
}

/**
 * Releases every lock expired at `now`, so its held builds deploy. Run by the
 * worker every 60 s and once on boot, which also catches locks that expired
 * while the worker was down. One failing environment does not stop the
 * others. Returns how many expired locks it found.
 */
export async function sweepExpiredLocks(now = new Date()): Promise<number> {
  const expired = await listExpiredDeployLocks(now);
  for (const environmentId of expired) {
    try {
      await releaseLock(environmentId, "expired", null, { now });
    } catch (error) {
      console.error(
        `Failed to release the expired deploy lock of ${environmentId}:`,
        error
      );
    }
  }
  return expired.length;
}
