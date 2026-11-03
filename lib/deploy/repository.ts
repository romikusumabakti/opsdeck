import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type Build,
  builds,
  type DeployApp,
  type Deployment,
  type DeployTarget,
  deployApps,
  deployments,
  deployTargets,
  type NewDeployTarget,
  runs,
  users,
} from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/people/names";
import { decryptSecret } from "@/lib/secrets";

const RECENT_LIMIT = 20;

export type TargetState = DeployTarget & {
  runningTag: string | null;
  previousTag: string | null;
  recentBuilds: Build[];
  recentDeployments: (Deployment & { userName: string | null })[];
};

export async function getDeployApp(
  appKey: string
): Promise<(DeployApp & { notifySecretPlain: string }) | null> {
  const [row] = await db
    .select()
    .from(deployApps)
    .where(eq(deployApps.appKey, appKey));
  if (!row) return null;
  return { ...row, notifySecretPlain: decryptSecret(row.notifySecret) };
}

export async function insertBuildIfNew(b: {
  appKey: string;
  branch: string;
  tag: string;
  commitSha: string;
  pipelineUrl: string | null;
}): Promise<{ build: Build; created: boolean }> {
  const [inserted] = await db
    .insert(builds)
    .values(b)
    .onConflictDoNothing({ target: [builds.appKey, builds.tag] })
    .returning();
  if (inserted) return { build: inserted, created: true };
  const existing = await findBuild(b.appKey, b.tag);
  if (!existing) {
    throw new Error(`Build ${b.appKey}:${b.tag} vanished after a conflict`);
  }
  return { build: existing, created: false };
}

export async function findAutoTargets(
  appKey: string,
  branch: string
): Promise<DeployTarget[]> {
  return db
    .select()
    .from(deployTargets)
    .where(
      and(
        eq(deployTargets.appKey, appKey),
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

export async function listTargetsForEnvironment(
  environmentId: string
): Promise<TargetState[]> {
  const targets = await db
    .select()
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(deployTargets.appKey);

  return Promise.all(
    targets.map(async (target) => {
      const [successTags, recentBuilds, recentDeployments] = await Promise.all([
        db
          .select({ tag: deployments.tag })
          .from(deployments)
          .where(
            and(
              eq(deployments.targetId, target.id),
              eq(deployments.status, "success")
            )
          )
          .orderBy(desc(deployments.createdAt), desc(deployments.id)),
        db
          .select()
          .from(builds)
          .where(
            and(
              eq(builds.appKey, target.appKey),
              eq(builds.branch, target.sourceBranch)
            )
          )
          .orderBy(desc(builds.receivedAt), desc(builds.id))
          .limit(RECENT_LIMIT),
        db
          .select({ deployment: deployments, userName: users.name })
          .from(deployments)
          .innerJoin(runs, eq(runs.id, deployments.runId))
          .leftJoin(users, eq(users.id, runs.userId))
          .where(eq(deployments.targetId, target.id))
          .orderBy(desc(deployments.createdAt), desc(deployments.id))
          .limit(RECENT_LIMIT),
      ]);
      const runningTag = successTags[0]?.tag ?? null;
      const previousTag =
        successTags.find((r) => r.tag !== runningTag)?.tag ?? null;
      return {
        ...target,
        runningTag,
        previousTag,
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
  appKey: string,
  tag: string
): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.appKey, appKey), eq(builds.tag, tag)));
  return row ?? null;
}

export async function insertDeployment(d: {
  targetId: string;
  environmentId: string;
  runId: string;
  tag: string;
  trigger: Deployment["trigger"];
  buildId: string | null;
}): Promise<Deployment> {
  return one(await db.insert(deployments).values(d).returning(), "deployment");
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id));
  return row ?? null;
}

/** Marks older queued auto deployments of the target as superseded. */
export async function supersedeQueuedAuto(
  targetId: string,
  exceptId: string
): Promise<number> {
  const rows = await db
    .update(deployments)
    .set({ status: "superseded", finishedAt: sql`now()` })
    .where(
      and(
        eq(deployments.targetId, targetId),
        eq(deployments.status, "queued"),
        eq(deployments.trigger, "auto"),
        ne(deployments.id, exceptId)
      )
    )
    .returning({ id: deployments.id });
  return rows.length;
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
        .set({ status: "running", startedAt: sql`now()` })
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

/**
 * Restarts a running deployment's stale-sweep clock. Called once the
 * pre-deploy backup is done, so a long backup does not count against the
 * deploy script's own bound.
 */
export async function touchRunningDeployment(id: string): Promise<void> {
  await db
    .update(deployments)
    .set({ startedAt: sql`now()` })
    .where(and(eq(deployments.id, id), eq(deployments.status, "running")));
}

/**
 * Fails deployments that have been running longer than any live deploy can
 * (the worker died mid-deploy and nothing will finish them), so they stop
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
        sql`${deployments.startedAt} < now() - ${olderThanMs} * interval '1 millisecond'`
      )
    )
    .returning({ runId: deployments.runId });
  return rows.map((r) => r.runId);
}

export async function upsertTarget(
  input: NewDeployTarget & { id?: string }
): Promise<DeployTarget> {
  if (!input.id) {
    return one(
      await db.insert(deployTargets).values(input).returning(),
      "deploy target"
    );
  }
  const { id, ...fields } = input;
  const [row] = await db
    .update(deployTargets)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(deployTargets.id, id))
    .returning();
  if (!row) throw new Error(`Deploy target ${id} not found`);
  return row;
}

export async function deleteTarget(id: string): Promise<void> {
  await db.delete(deployTargets).where(eq(deployTargets.id, id));
}
