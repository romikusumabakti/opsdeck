import {
  claimDeployment,
  finishDeployment,
  getDeployApp,
  getDeployment,
  getTarget,
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

export type DeployJobResult = {
  status: "success" | "failed" | "superseded" | "requeued";
};

// An expected failure whose message is already in the run output.
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
  if (claim === "gone") {
    await appendRunOutput(runId, "Superseded by a newer build");
    await completeRun(runId);
    return { status: "superseded" };
  }
  if (claim === "busy") {
    await appendRunOutput(
      runId,
      "Waiting for the running deploy in this environment"
    );
    await enqueue("deploy/run.requested", data, {
      delayMs: BUSY_RETRY_DELAY_MS,
    });
    return { status: "requeued" };
  }

  // Claimed: from here on every exit must finish the deployment, or it would
  // stay `running` and block the environment for good.
  try {
    await runClaimedDeployment(deploymentId, runId);
    await finishDeployment(deploymentId, "success");
    await completeRun(runId);
    return { status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Includes the script's own output for a non-zero exit (HEALTH TIMEOUT).
    if (!(err instanceof DeployAborted)) {
      await appendRunOutput(runId, `✗ ${message}`);
    }
    await finishDeployment(deploymentId, "failed");
    await failRun(runId, message);
    return { status: "failed" };
  }
}

async function runClaimedDeployment(
  deploymentId: string,
  runId: string
): Promise<void> {
  const registry = process.env.DEPLOY_REGISTRY;
  if (!registry) {
    return abort(runId, "Deploy disabled: DEPLOY_REGISTRY is not set");
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
      // Completes or fails its own run.
      await handleCreateDatabaseBackup({
        environmentId: target.environmentId,
        runId: backupRunId,
      });
    } catch {
      return abort(runId, "Backup failed — deploy aborted");
    }
  }

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

async function abort(runId: string, message: string): Promise<never> {
  await appendRunOutput(runId, message);
  throw new DeployAborted(message);
}
