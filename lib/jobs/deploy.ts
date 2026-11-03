import {
  claimDeployment,
  failStaleRunningDeployments,
  finishDeployment,
  getDeployApp,
  getDeployment,
  getTarget,
  heartbeatDeployment,
  markScriptStarted,
} from "@/lib/deploy/repository";
import { buildDeployScript } from "@/lib/deploy/script";
import { loadServerCredentials } from "@/lib/environments";
import { handleCreateDatabaseBackup } from "@/lib/jobs/processor";
import { enqueue, type JobMap } from "@/lib/queue";
import {
  appendRunOutput,
  completeRun,
  createRun,
  failRun,
} from "@/lib/run-progress";
import { executeRemoteCommand } from "@/lib/ssh";

// How long a deploy waits before re-trying the claim while another deploy runs
// in the same environment.
const BUSY_RETRY_DELAY_MS = 15_000;

// Wall-clock bound on the whole deploy script: image pulls, the pre-start hook
// and the health wait (itself bounded by the target's healthTimeoutSeconds).
const DEPLOY_COMMAND_TIMEOUT_MS = 20 * 60_000;

/**
 * While a deploy runs, its worker bumps the deployment's heartbeat this often.
 * A running deployment whose heartbeat is older than STALE_RUNNING_DEPLOY_MS has
 * no live worker behind it, however long its backup or script legitimately take.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const STALE_RUNNING_DEPLOY_MS = 5 * 60_000;

const INTERRUPTED_MESSAGE =
  "Worker restarted during deploy — server state unknown";

export type DeployJobResult = {
  status: "success" | "failed" | "superseded" | "requeued" | "already-finished";
};

// An expected failure; its message is the whole story for the run log.
class DeployAborted extends Error {}

/**
 * Runs one deployment. At most one deployment runs per environment (enforced by
 * claimDeployment's partial unique index); a busy environment re-enqueues the
 * job instead of waiting in a worker slot. A failure leaves the deployment and
 * its run failed — there is never an automatic rollback.
 *
 * Returns rather than throws on a failed deploy: the outcome lives in the
 * deployment row and the run, and the job runs with attempts: 1, so a throw
 * would only add a duplicate failed-job record in Redis.
 */
export async function handleDeploy(
  data: JobMap["deploy/run.requested"]
): Promise<DeployJobResult> {
  const { deploymentId, runId } = data;

  const claim = await claimDeployment(deploymentId);
  switch (claim) {
    case "superseded":
      await appendRunOutput(runId, "Superseded by a newer build");
      await completeRun(runId);
      return { status: "superseded" };
    case "busy":
      // A deploy whose worker died would hold the environment forever; clear
      // those before waiting on it. Best-effort: a sweep error must not skip
      // the re-enqueue, or this deployment would stay queued for good.
      await bestEffort("sweep stale deployments", failStaleDeployments);
      await appendRunOutput(
        runId,
        "Waiting for the running deploy in this environment"
      );
      await enqueue("deploy/run.requested", data, {
        delayMs: BUSY_RETRY_DELAY_MS,
      });
      return { status: "requeued" };
    case "interrupted":
      // Redelivered by BullMQ after the worker died mid-deploy. Re-running the
      // script blind is not safe; fail it and let a person decide.
      await failClaimedDeployment(deploymentId, runId, INTERRUPTED_MESSAGE);
      return { status: "failed" };
    case "finished":
      // Duplicate delivery of a deployment that already has its outcome.
      return { status: "already-finished" };
    case "claimed":
      break;
  }

  // Claimed: keep the heartbeat going until the job is done, so the stale
  // sweep only ever fails deployments whose worker died.
  const heartbeat = setInterval(() => {
    void bestEffort("record the heartbeat", () =>
      heartbeatDeployment(deploymentId)
    );
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await recordClaimedDeployment(deploymentId, runId);
  } finally {
    clearInterval(heartbeat);
  }
}

// From here on every exit must finish the deployment, or it would stay
// `running` and block the environment until the stale sweep.
async function recordClaimedDeployment(
  deploymentId: string,
  runId: string
): Promise<DeployJobResult> {
  try {
    await runClaimedDeployment(deploymentId, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An unexpected error (SSH non-zero exit, with the script's output and
    // HEALTH TIMEOUT) is marked as such; an abort is a plain sentence.
    const line = err instanceof DeployAborted ? message : `✗ ${message}`;
    await failClaimedDeployment(deploymentId, runId, message, line);
    return { status: "failed" };
  }

  let finished: boolean;
  try {
    finished = await finishDeployment(deploymentId, "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failClaimedDeployment(deploymentId, runId, message, `✗ ${message}`);
    return { status: "failed" };
  }
  if (!finished) {
    // The stale sweep failed it (and its run) while the script was running.
    await bestEffort("append to the run", () =>
      appendRunOutput(
        runId,
        "Deploy script finished after the deployment was marked failed"
      )
    );
    return { status: "failed" };
  }
  // The deployment succeeded; a run-row hiccup must not turn that into a
  // failed run.
  await bestEffort("complete the run", () => completeRun(runId));
  return { status: "success" };
}

/**
 * Fails a claimed deployment and its run. The deployment row goes first: it is
 * what blocks the environment. Each step is best-effort so one failing write
 * does not skip the next.
 */
async function failClaimedDeployment(
  deploymentId: string,
  runId: string,
  message: string,
  line: string = message
): Promise<void> {
  await bestEffort("fail the deployment", () =>
    finishDeployment(deploymentId, "failed")
  );
  await bestEffort("append to the run", () => appendRunOutput(runId, line));
  await bestEffort("fail the run", () => failRun(runId, message));
}

/**
 * Fails deployments left `running` by a dead worker, and their runs. Called on
 * worker start and whenever a deploy finds its environment busy.
 */
export async function failStaleDeployments(): Promise<void> {
  const runIds = await failStaleRunningDeployments(STALE_RUNNING_DEPLOY_MS);
  const minutes = Math.round(STALE_RUNNING_DEPLOY_MS / 60_000);
  const message = `Marked failed: no progress for over ${minutes} minutes (worker restart?)`;
  for (const id of runIds) {
    await bestEffort("append to the run", () => appendRunOutput(id, message));
    await bestEffort("fail the run", () => failRun(id, message));
  }
}

async function bestEffort(
  label: string,
  fn: () => Promise<unknown>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`Deploy: could not ${label}:`, error);
  }
}

async function runClaimedDeployment(
  deploymentId: string,
  runId: string
): Promise<void> {
  const registry = process.env.DEPLOY_REGISTRY;
  if (!registry) {
    throw new DeployAborted("Deploy disabled: DEPLOY_REGISTRY is not set");
  }

  const deployment = await getDeployment(deploymentId);
  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  const target = await getTarget(deployment.targetId);
  if (!target)
    throw new Error(`Deploy target ${deployment.targetId} not found`);
  const app = await getDeployApp(target.appKey);
  if (!app) throw new Error(`Deploy app ${target.appKey} not found`);
  const credentials = await loadServerCredentials(target.serverId);
  if (!credentials) throw new Error(`Server ${target.serverId} not found`);

  // Built (and validated) before the backup, so a bad target fails the deploy
  // without taking a backup first.
  const script = buildDeployScript({
    registry,
    bundleImage: app.bundleImage,
    tag: deployment.tag,
    deployDir: target.deployDir,
    services: target.services,
    tagVariable: target.tagVariable,
    preStartCommand: target.preStartCommand,
    healthUrl: target.healthUrl,
    healthTimeoutSeconds: target.healthTimeoutSeconds,
  });

  if (target.backupBeforeDeploy) {
    const backupRunId = await createRun({
      environmentId: target.environmentId,
      userId: null,
      description: `Pre-deploy backup for ${target.appKey} ${deployment.tag}`,
      kind: "backup",
    });
    await appendRunOutput(
      runId,
      `Backing up the database (run ${backupRunId})`
    );
    try {
      // Completes or fails its own run, except when it throws before its own
      // try (environment not found) — hence the failRun below.
      await handleCreateDatabaseBackup({
        environmentId: target.environmentId,
        runId: backupRunId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await bestEffort("fail the backup run", () =>
        failRun(backupRunId, message)
      );
      throw new DeployAborted("Backup failed — deploy aborted");
    }
  }

  // The last check before touching the server: if the stale sweep failed this
  // deployment (say the heartbeat stalled during a long backup), another
  // deploy may already own the environment.
  if (!(await heartbeatDeployment(deploymentId))) {
    throw new DeployAborted(
      "Deployment was marked failed while waiting (stale) — not deploying"
    );
  }
  // From here the server may run this tag, even if the deploy then fails. Not
  // best-effort: if it cannot be recorded, do not touch the server.
  await markScriptStarted(deploymentId);

  await appendRunOutput(
    runId,
    `Deploying ${target.appKey} ${deployment.tag} to ${target.deployDir}`
  );
  const output = await executeRemoteCommand(
    credentials,
    script,
    DEPLOY_COMMAND_TIMEOUT_MS
  );
  const trimmed = output.trim();
  if (trimmed) await appendRunOutput(runId, trimmed);
}
