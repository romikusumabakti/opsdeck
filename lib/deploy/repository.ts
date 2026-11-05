import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type Build,
  builds,
  type Deployment,
  type DeployTarget,
  deployments,
  deployTargets,
  type EnvironmentDeployLock,
  environmentDeployLocks,
  environmentServices,
  environments,
  type NewDeployTarget,
  runs,
  users,
} from "@/lib/db/schema";
import { placementFor, planHeldRelease } from "@/lib/deploy/lock";
import { isUniqueViolation } from "@/lib/people/names";

const RECENT_LIMIT = 20;

/**
 * What the target's server runs, as far as the Panel knows.
 * - currentTag: the tag of the latest deployment whose script reached the
 *   server. After a failed deploy the server may run it, half-started — it is
 *   not necessarily a good release (see currentStatus).
 * - previousTag: the latest successful tag other than currentTag — what a
 *   rollback deploys.
 */
export type TagState = {
  currentTag: string | null;
  currentStatus: Deployment["status"] | null;
  previousTag: string | null;
};

export type TargetState = DeployTarget &
  TagState & {
    recentBuilds: Build[];
    recentDeployments: (Deployment & { userName: string | null })[];
  };

type TagStateRow = Pick<
  Deployment,
  "id" | "tag" | "status" | "scriptStartedAt" | "startedAt" | "finishedAt"
>;

const settledAt = (r: TagStateRow) =>
  (r.finishedAt ?? r.startedAt)?.getTime() ?? 0;

/**
 * Derives the tag state from a target's deployments. Only deployments whose
 * script started count: one that failed before (say its backup failed) never
 * touched the server. Newest first by finish (or start) time, then id.
 */
export function deriveTagState(rows: TagStateRow[]): TagState {
  const touched = rows
    .filter((r) => r.scriptStartedAt !== null)
    .sort((a, b) => settledAt(b) - settledAt(a) || b.id.localeCompare(a.id));
  const current = touched[0];
  const currentTag = current?.tag ?? null;
  const previous = touched.find(
    (r) => r.status === "success" && r.tag !== currentTag
  );
  return {
    currentTag,
    currentStatus: current?.status ?? null,
    previousTag: previous?.tag ?? null,
  };
}

/** The target's current and rollback tags; see {@link TagState}. */
export async function getTagState(targetId: string): Promise<TagState> {
  const rows = await db
    .select({
      id: deployments.id,
      tag: deployments.tag,
      status: deployments.status,
      scriptStartedAt: deployments.scriptStartedAt,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.targetId, targetId),
        isNotNull(deployments.scriptStartedAt)
      )
    );
  return deriveTagState(rows);
}

export async function insertBuildIfNew(b: {
  componentKey: string;
  branch: string;
  tag: string;
  commitSha: string;
  pipelineUrl: string | null;
}): Promise<{ build: Build; created: boolean }> {
  const [inserted] = await db
    .insert(builds)
    .values(b)
    .onConflictDoNothing({ target: [builds.componentKey, builds.tag] })
    .returning();
  if (inserted) return { build: inserted, created: true };
  const existing = await findBuild(b.componentKey, b.tag);
  if (!existing) {
    throw new Error(
      `Build ${b.componentKey}:${b.tag} vanished after a conflict`
    );
  }
  return { build: existing, created: false };
}

export async function findAutoTargets(
  componentKey: string,
  branch: string
): Promise<DeployTarget[]> {
  return db
    .select()
    .from(deployTargets)
    .where(
      and(
        eq(deployTargets.componentKey, componentKey),
        eq(deployTargets.sourceBranch, branch),
        eq(deployTargets.autoDeploy, true)
      )
    );
}

export async function getTarget(id: string): Promise<DeployTarget | null> {
  const [row] = await db
    .select()
    .from(deployTargets)
    .where(eq(deployTargets.id, id));
  return row ?? null;
}

/**
 * The tag variables of every deploy target that writes the `.env` in this
 * deploy dir on this server (a multi-component app has one per component),
 * once each, sorted.
 */
export async function listTagVariablesInDeployDir(
  serverId: string,
  deployDir: string
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: deployTargets.tagVariable })
    .from(deployTargets)
    .where(
      and(
        eq(deployTargets.serverId, serverId),
        eq(deployTargets.deployDir, deployDir)
      )
    )
    .orderBy(deployTargets.tagVariable);
  return rows.map((row) => row.name);
}

/**
 * Whether a deploy target of another environment also deploys into this
 * deploy dir on this server — then the dir's `.env` cannot be managed.
 */
export async function deployDirSharedWithOtherEnvironment(
  serverId: string,
  deployDir: string,
  environmentId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: deployTargets.id })
    .from(deployTargets)
    .where(
      and(
        eq(deployTargets.serverId, serverId),
        eq(deployTargets.deployDir, deployDir),
        ne(deployTargets.environmentId, environmentId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function listTargetsForEnvironment(
  environmentId: string
): Promise<TargetState[]> {
  const targets = await db
    .select()
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(deployTargets.componentKey);

  return Promise.all(
    targets.map(async (target) => {
      const [tagState, recentBuilds, recentDeployments] = await Promise.all([
        getTagState(target.id),
        db
          .select()
          .from(builds)
          .where(
            and(
              eq(builds.componentKey, target.componentKey),
              eq(builds.branch, target.sourceBranch)
            )
          )
          .orderBy(desc(builds.receivedAt), desc(builds.id))
          .limit(RECENT_LIMIT),
        db
          .select({ deployment: deployments, userName: users.name })
          .from(deployments)
          // Left join: a held deployment has no run yet.
          .leftJoin(runs, eq(runs.id, deployments.runId))
          .leftJoin(users, eq(users.id, runs.userId))
          .where(eq(deployments.targetId, target.id))
          .orderBy(desc(deployments.createdAt), desc(deployments.id))
          .limit(RECENT_LIMIT),
      ]);
      return {
        ...target,
        ...tagState,
        recentBuilds,
        recentDeployments: recentDeployments.map((r) => ({
          ...r.deployment,
          userName: r.userName,
        })),
      };
    })
  );
}

export async function findBuild(
  componentKey: string,
  tag: string
): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.componentKey, componentKey), eq(builds.tag, tag)));
  return row ?? null;
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id));
  return row ?? null;
}

/**
 * Marks the target's older queued or held auto deployments as superseded, so
 * of several quick builds only the newest deploys — now, or when the
 * environment's deploy lock is released.
 */
export async function supersedeQueuedAuto(
  targetId: string,
  exceptId: string,
  executor: DbExecutor = db
): Promise<number> {
  const rows = await executor
    .update(deployments)
    .set({ status: "superseded", finishedAt: sql`now()` })
    .where(
      and(
        eq(deployments.targetId, targetId),
        inArray(deployments.status, ["queued", "held"]),
        eq(deployments.trigger, "auto"),
        ne(deployments.id, exceptId)
      )
    )
    .returning({ id: deployments.id });
  return rows.length;
}

export type DeployLockWithLocker = EnvironmentDeployLock & {
  lockerName: string | null;
};

/** The environment's lock row, expired or not, with the locker's name. */
export async function getDeployLock(
  environmentId: string
): Promise<DeployLockWithLocker | null> {
  const [row] = await db
    .select({ lock: environmentDeployLocks, lockerName: users.name })
    .from(environmentDeployLocks)
    .leftJoin(users, eq(users.id, environmentDeployLocks.lockedBy))
    .where(eq(environmentDeployLocks.environmentId, environmentId));
  return row ? { ...row.lock, lockerName: row.lockerName } : null;
}

/** What the lock rules need of an environment: its name and owner. */
export async function getEnvironmentForLock(
  environmentId: string
): Promise<{ id: string; name: string; ownerId: string | null } | null> {
  const [row] = await db
    .select({
      id: environments.id,
      name: environments.name,
      ownerId: environments.ownerId,
    })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return row ?? null;
}

export async function countHeldDeployments(
  environmentId: string
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deployments)
    .where(
      and(
        eq(deployments.environmentId, environmentId),
        eq(deployments.status, "held")
      )
    );
  return row?.count ?? 0;
}

/**
 * Sets a lock on an unlocked environment. False when the environment already
 * has a lock row (someone locked first). `createdAt` is set by the caller, in
 * milliseconds, so it can identify this lock in a later conditional write.
 */
export async function insertDeployLock(lock: {
  environmentId: string;
  lockedBy: string;
  reason: string;
  expiresAt: Date;
  createdAt: Date;
}): Promise<boolean> {
  const rows = await db
    .insert(environmentDeployLocks)
    .values(lock)
    .onConflictDoNothing({ target: environmentDeployLocks.environmentId })
    .returning({ id: environmentDeployLocks.environmentId });
  return rows.length > 0;
}

/**
 * Changes the reason and expiry of the lock created at `createdAt`. False when
 * that lock is gone (released, or replaced by another).
 */
export async function updateDeployLock(
  environmentId: string,
  createdAt: Date,
  changes: { reason: string; expiresAt: Date }
): Promise<boolean> {
  const rows = await db
    .update(environmentDeployLocks)
    .set(changes)
    .where(
      and(
        eq(environmentDeployLocks.environmentId, environmentId),
        eq(environmentDeployLocks.createdAt, createdAt)
      )
    )
    .returning({ id: environmentDeployLocks.environmentId });
  return rows.length > 0;
}

/** Environments whose lock expired at or before `now`. */
export async function listExpiredDeployLocks(now: Date): Promise<string[]> {
  const rows = await db
    .select({ environmentId: environmentDeployLocks.environmentId })
    .from(environmentDeployLocks)
    .where(lte(environmentDeployLocks.expiresAt, now));
  return rows.map((row) => row.environmentId);
}

function runLine(now: Date, line: string): string {
  return `[${now.toISOString()}] ${line}\n`;
}

/** The description of a deployment's run. */
export function deploymentRunDescription(
  componentKey: string,
  tag: string,
  trigger: Deployment["trigger"]
): string {
  return `Deploy ${componentKey} ${tag} (${trigger})`;
}

export type PlaceDeploymentResult =
  | { kind: "queued"; deploymentId: string; runId: string }
  | { kind: "held"; deploymentId: string; runId: null }
  | { kind: "locked"; lock: DeployLockWithLocker };

/**
 * Records a deployment, deciding under the environment's lock in the same
 * transaction:
 * - no active lock: the deployment is `queued` with a `started` run; the
 *   caller enqueues it.
 * - locked, `auto`: the deployment is `held`, with no run at all — nothing
 *   ran, so nothing may show as running, succeeded or failed (Home's
 *   "needs attention" and the success rate read runs). releaseDeployLock
 *   creates the run when it queues the deployment.
 * - locked, `manual` or `rollback`: nothing is written; the caller refuses.
 *
 * The lock row is read FOR SHARE: a release deletes it, so a release and a
 * request are serialized — either the request sees the lock and its held row
 * is visible to the release, or it sees no lock and queues.
 */
export async function placeDeployment(input: {
  targetId: string;
  environmentId: string;
  tag: string;
  trigger: Deployment["trigger"];
  userId: string | null;
  buildId: string | null;
  description: string;
  now: Date;
}): Promise<PlaceDeploymentResult> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ lock: environmentDeployLocks, lockerName: users.name })
      .from(environmentDeployLocks)
      .leftJoin(users, eq(users.id, environmentDeployLocks.lockedBy))
      .where(eq(environmentDeployLocks.environmentId, input.environmentId))
      .for("share", { of: environmentDeployLocks });
    const lock = found ? { ...found.lock, lockerName: found.lockerName } : null;
    const placement = placementFor(lock, input.trigger, input.now);
    if (placement === "locked" && lock) {
      return { kind: "locked", lock };
    }
    const held = placement === "held";
    const runId = held
      ? null
      : one(
          await tx
            .insert(runs)
            .values({
              environmentId: input.environmentId,
              userId: input.userId,
              description: input.description,
              kind: "deploy",
              runAt: input.now,
              status: "started",
              output: "",
            })
            .returning({ id: runs.id }),
          "run"
        ).id;
    const deployment = one(
      await tx
        .insert(deployments)
        .values({
          targetId: input.targetId,
          environmentId: input.environmentId,
          runId,
          tag: input.tag,
          trigger: input.trigger,
          buildId: input.buildId,
          status: held ? "held" : "queued",
        })
        .returning({ id: deployments.id }),
      "deployment"
    );
    if (input.trigger === "auto") {
      await supersedeQueuedAuto(input.targetId, deployment.id, tx);
    }
    return runId === null
      ? { kind: "held", deploymentId: deployment.id, runId: null }
      : { kind: "queued", deploymentId: deployment.id, runId };
  });
}

export type ReleasedLock = {
  lock: EnvironmentDeployLock;
  queued: { deploymentId: string; runId: string }[];
  superseded: string[];
};

/**
 * Deletes the environment's lock and, in the same transaction, turns per
 * target the newest held deployment into `queued` — creating its run now —
 * and the older held ones into `superseded` (they never get a run). The
 * caller enqueues the queued ones with the returned run ids.
 *
 * Null when there was no matching lock to delete — already released by a
 * concurrent unlock or sweep — so each held deployment is queued at most once:
 * the DELETE takes the lock row, a second release waits for the first and then
 * finds nothing; the held rows are also read FOR UPDATE and changed only while
 * still `held`. `match.createdAt` limits the delete to the lock the caller
 * checked (not one set since); `match.expiredAt` to a lock expired by then.
 */
export async function releaseDeployLock(
  environmentId: string,
  match: { createdAt?: Date; expiredAt?: Date } = {}
): Promise<ReleasedLock | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const conditions: SQL[] = [
      eq(environmentDeployLocks.environmentId, environmentId),
    ];
    if (match.createdAt) {
      conditions.push(eq(environmentDeployLocks.createdAt, match.createdAt));
    }
    if (match.expiredAt) {
      conditions.push(lte(environmentDeployLocks.expiresAt, match.expiredAt));
    }
    const [lock] = await tx
      .delete(environmentDeployLocks)
      .where(and(...conditions))
      .returning();
    if (!lock) return null;

    const heldRows = await tx
      .select({
        id: deployments.id,
        targetId: deployments.targetId,
        createdAt: deployments.createdAt,
        tag: deployments.tag,
        trigger: deployments.trigger,
        componentKey: deployTargets.componentKey,
      })
      .from(deployments)
      .innerJoin(deployTargets, eq(deployTargets.id, deployments.targetId))
      .where(
        and(
          eq(deployments.environmentId, environmentId),
          eq(deployments.status, "held")
        )
      )
      .for("update", { of: deployments });
    const plan = planHeldRelease(heldRows);

    const queuedIds =
      plan.queue.length === 0
        ? []
        : await tx
            .update(deployments)
            .set({ status: "queued" })
            .where(
              and(
                inArray(deployments.id, plan.queue),
                eq(deployments.status, "held")
              )
            )
            .returning({ id: deployments.id });
    const queued: ReleasedLock["queued"] = [];
    for (const { id } of queuedIds) {
      const row = heldRows.find((r) => r.id === id);
      if (!row) continue;
      const run = one(
        await tx
          .insert(runs)
          .values({
            environmentId,
            userId: null,
            description: deploymentRunDescription(
              row.componentKey,
              row.tag,
              row.trigger
            ),
            kind: "deploy",
            runAt: now,
            status: "started",
            output: runLine(now, "Deploy lock released: queued to deploy"),
          })
          .returning({ id: runs.id }),
        "run"
      );
      await tx
        .update(deployments)
        .set({ runId: run.id })
        .where(eq(deployments.id, id));
      queued.push({ deploymentId: id, runId: run.id });
    }

    const superseded =
      plan.supersede.length === 0
        ? []
        : await tx
            .update(deployments)
            .set({ status: "superseded", finishedAt: sql`now()` })
            .where(
              and(
                inArray(deployments.id, plan.supersede),
                eq(deployments.status, "held")
              )
            )
            .returning({ id: deployments.id });

    return { lock, queued, superseded: superseded.map((row) => row.id) };
  });
}

/**
 * What claiming a deployment found:
 * - "claimed": it was queued and is now running.
 * - "busy": another deployment is already running in the environment (partial
 *   unique index); it stays queued.
 * - "superseded": a newer auto deployment replaced it while it was queued.
 * - "interrupted": it is already running — a redelivery after the worker died
 *   mid-deploy, so the server's state is unknown.
 * - "finished": it already succeeded or failed (a duplicate delivery), or the
 *   row is gone; there is nothing to do.
 */
export type ClaimResult =
  | "claimed"
  | "busy"
  | "superseded"
  | "interrupted"
  | "finished";

export async function claimDeployment(id: string): Promise<ClaimResult> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .update(deployments)
        .set({
          status: "running",
          startedAt: sql`now()`,
          heartbeatAt: sql`now()`,
        })
        .where(and(eq(deployments.id, id), eq(deployments.status, "queued")))
        .returning({ id: deployments.id });
      if (rows.length > 0) return "claimed";
      const [row] = await tx
        .select({ status: deployments.status })
        .from(deployments)
        .where(eq(deployments.id, id));
      return unclaimedOutcome(row?.status);
    });
  } catch (error) {
    if (isUniqueViolation(error)) return "busy";
    throw error;
  }
}

function unclaimedOutcome(
  status: Deployment["status"] | undefined
): Exclude<ClaimResult, "claimed"> {
  switch (status) {
    case "superseded":
      return "superseded";
    case "running":
      return "interrupted";
    // Still queued means the row changed between the update and this read;
    // try again later rather than guess.
    case "queued":
      return "busy";
    default:
      return "finished";
  }
}

/**
 * Moves a running deployment to its final status. False when it was no longer
 * running (the stale sweep already failed it), so the caller must not report
 * success.
 */
export async function finishDeployment(
  id: string,
  status: "success" | "failed"
): Promise<boolean> {
  const rows = await db
    .update(deployments)
    .set({ status, finishedAt: sql`now()` })
    .where(and(eq(deployments.id, id), eq(deployments.status, "running")))
    .returning({ id: deployments.id });
  return rows.length > 0;
}

/** Records that the deploy script is about to be sent to the server. */
export async function markScriptStarted(id: string): Promise<void> {
  await db
    .update(deployments)
    .set({ scriptStartedAt: sql`now()` })
    .where(eq(deployments.id, id));
}

/**
 * Records that the worker running this deployment is alive. False when the
 * deployment is no longer running (the stale sweep failed it), so the caller
 * must stop before touching the server.
 */
export async function heartbeatDeployment(id: string): Promise<boolean> {
  const rows = await db
    .update(deployments)
    .set({ heartbeatAt: sql`now()` })
    .where(and(eq(deployments.id, id), eq(deployments.status, "running")))
    .returning({ id: deployments.id });
  return rows.length > 0;
}

/**
 * Fails running deployments whose heartbeat stopped more than `olderThanMs`
 * ago (the worker died mid-deploy and nothing will finish them), so they stop
 * blocking their environment. Returns the run ids of the rows it failed.
 */
export async function failStaleRunningDeployments(
  olderThanMs: number
): Promise<string[]> {
  const rows = await db
    .update(deployments)
    .set({ status: "failed", finishedAt: sql`now()` })
    .where(
      and(
        eq(deployments.status, "running"),
        sql`coalesce(${deployments.heartbeatAt}, ${deployments.startedAt}) < now() - ${olderThanMs} * interval '1 millisecond'`
      )
    )
    .returning({ runId: deployments.runId });
  // A running deployment always has its run; only held ones have none.
  return rows.flatMap((r) => (r.runId ? [r.runId] : []));
}

export async function upsertTarget(
  input: NewDeployTarget | (Partial<NewDeployTarget> & { id: string }),
  executor: DbExecutor = db
): Promise<DeployTarget> {
  if (!("id" in input) || !input.id) {
    return one(
      await executor
        .insert(deployTargets)
        .values(input as NewDeployTarget)
        .returning(),
      "deploy target"
    );
  }
  const { id, ...fields } = input;
  const [row] = await executor
    .update(deployTargets)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(deployTargets.id, id))
    .returning();
  if (!row) throw new Error(`Deploy target ${id} not found`);
  return row;
}

/** Whether a service of the environment runs on this server. */
export async function environmentUsesServer(
  environmentId: string,
  serverId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: environmentServices.id })
    .from(environmentServices)
    .where(
      and(
        eq(environmentServices.environmentId, environmentId),
        eq(environmentServices.serverId, serverId)
      )
    )
    .limit(1);
  return row !== undefined;
}

export async function deleteTarget(id: string): Promise<void> {
  await db.delete(deployTargets).where(eq(deployTargets.id, id));
}
