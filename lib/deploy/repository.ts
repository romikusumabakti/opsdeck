import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type Build,
  builds,
  type Deployment,
  type DeployTarget,
  deployments,
  deployTargets,
  environmentServices,
  type NewDeployTarget,
  runs,
  users,
} from "@/lib/db/schema";
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
          .innerJoin(runs, eq(runs.id, deployments.runId))
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
  return rows.map((r) => r.runId);
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
