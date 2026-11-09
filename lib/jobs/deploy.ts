import { getComponent } from "@/lib/apps";
import {
  claimDeployment,
  deployDirSharedWithOtherEnvironment,
  failStaleRunningDeployments,
  finishDeployment,
  getDeployment,
  getRunActor,
  getTarget,
  heartbeatDeployment,
  listServicesInDeployDir,
  listTagVariablesInDeployDir,
  markScriptStarted,
} from "@/lib/deploy/repository";
import { preDeployBackupDescription } from "@/lib/deploy/run-actor";
import {
  buildDeployScript,
  stagedEnvFileName,
  stagedOverlayFileName,
} from "@/lib/deploy/script";
import { deployTagSchema, envVarNameSchema } from "@/lib/deploy/validation";
import { loadServerCredentials } from "@/lib/environments";
import { handleCreateDatabaseBackup } from "@/lib/jobs/processor";
import { enqueue, type JobMap } from "@/lib/queue";
import {
  appendRunOutput,
  completeRun,
  createRun,
  failRun,
} from "@/lib/run-progress";
import { shq } from "@/lib/sh";
import {
  executeRemoteCommand,
  type SshTarget,
  uploadRemoteContent,
} from "@/lib/ssh";
import {
  COMPOSE_OVERLAY_FILE,
  renderComposeOverlay,
} from "@/lib/variables/compose-overlay";
import { renderEnvFile } from "@/lib/variables/env-file";
import {
  loadManagedEnvFileVariables,
  loadSharedDatabaseNetwork,
} from "@/lib/variables/managed-env";

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

// Bound on reading the other components' tag lines from the server's .env.
const READ_TAGS_TIMEOUT_MS = 30_000;

// Bound on removing a staged .env the script never installed.
const REMOVE_STAGED_TIMEOUT_MS = 30_000;

const INTERRUPTED_MESSAGE =
  "Worker restarted during deploy — server state unknown";

export type DeployJobResult = {
  status:
    | "success"
    | "failed"
    | "superseded"
    | "held"
    | "cancelled"
    | "requeued"
    | "already-finished";
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

  const claim = await claimDeployment(deploymentId, runId);
  switch (claim) {
    // The environment was locked after this deployment was queued; the claim
    // already wrote the outcome: held (its run deleted — it deploys with a
    // new run on release) or cancelled (it and its run failed). Done, without
    // touching the run.
    case "held":
    case "cancelled":
      return { status: claim };
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
  const component = await getComponent(target.componentKey);
  if (!component) {
    throw new Error(`Component ${target.componentKey} not found`);
  }
  const credentials = await loadServerCredentials(target.serverId);
  if (!credentials) throw new Error(`Server ${target.serverId} not found`);

  // A managed environment gets its whole .env rendered from the Panel's
  // variables; null leaves the deploy exactly as it was before (tag line only).
  const managedVars = await loadManagedEnvFileVariables(target.environmentId);
  // Every tag variable written to this deploy dir's .env: this target's and,
  // for a multi-component app, the other components'.
  const tagVariables = managedVars
    ? await listTagVariablesInDeployDir(target.serverId, target.deployDir)
    : [];
  // A shared database host with a Docker network: the services join it through
  // a compose overlay installed with the .env (null: none, a leftover is removed).
  const databaseNetwork = managedVars
    ? await loadSharedDatabaseNetwork(target.environmentId, target.serverId)
    : null;
  // Every service of every target in this dir, so one component's deploy never
  // drops another's from the network.
  const overlayServices = databaseNetwork
    ? await listServicesInDeployDir(target.serverId, target.deployDir)
    : [];
  const composeOptions = databaseNetwork
    ? { composeFiles: ["compose.yaml", COMPOSE_OVERLAY_FILE] }
    : {};
  if (managedVars) {
    // The rendered .env replaces the whole file, so it must not be shared with
    // another environment's deploys (their variables would be overwritten).
    if (
      await deployDirSharedWithOtherEnvironment(
        target.serverId,
        target.deployDir,
        target.environmentId
      )
    ) {
      throw new DeployAborted(
        `Another environment deploys into ${target.deployDir} — a managed .env needs the directory to itself`
      );
    }
    // Validate now, with the deploying tag standing in for the values still
    // to be read from the server, so bad variables abort before the backup.
    renderManagedEnvFile(
      managedVars,
      Object.fromEntries(
        [...tagVariables, target.tagVariable].map((n) => [n, deployment.tag])
      ),
      registry,
      composeOptions
    );
    if (databaseNetwork) renderManagedOverlay(overlayServices, databaseNetwork);
  }

  // Built (and validated) before the backup, so a bad target fails the deploy
  // without taking a backup first.
  const script = buildDeployScript({
    registry,
    bundleImage: component.bundleImage,
    tag: deployment.tag,
    deployDir: target.deployDir,
    services: target.services,
    tagVariable: target.tagVariable,
    preStartCommand: target.preStartCommand,
    healthUrl: target.healthUrl,
    healthTimeoutSeconds: target.healthTimeoutSeconds,
    ...(managedVars
      ? {
          installStagedEnvFile: {
            deploymentId,
            variableCount: managedVars.length,
            overlay: databaseNetwork !== null,
          },
        }
      : {}),
  });

  if (target.backupBeforeDeploy) {
    // The backup is part of the deploy: it carries the deploy run's actor
    // (the Panel user, or the forge actor of an auto-deploy).
    const actor = await getRunActor(runId);
    const backupRunId = await createRun({
      environmentId: target.environmentId,
      userId: actor?.userId ?? null,
      triggeredBy: actor?.triggeredBy ?? null,
      description: preDeployBackupDescription(
        target.componentKey,
        deployment.tag
      ),
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
  // Set once the rendered .env is staged on the server; a failure before the
  // script ran removes it again (best-effort).
  let stagedPaths: string[] = [];
  if (managedVars) {
    // Staging the file changes nothing the server runs: a failure here fails
    // the deploy with the server's .env and containers untouched.
    const otherTags = tagVariables.filter((n) => n !== target.tagVariable);
    const tags = {
      ...(otherTags.length > 0
        ? await readServerTags(credentials, target.deployDir, otherTags)
        : {}),
      [target.tagVariable]: deployment.tag,
    };
    const content = renderManagedEnvFile(
      managedVars,
      tags,
      registry,
      composeOptions
    );
    const path = `${target.deployDir}/${stagedEnvFileName(deploymentId)}`;
    const uploads: [string, string][] = [[path, content]];
    if (databaseNetwork) {
      uploads.push([
        `${target.deployDir}/${stagedOverlayFileName(deploymentId)}`,
        renderManagedOverlay(overlayServices, databaseNetwork),
      ]);
    }
    const uploadPaths = uploads.map(([p]) => p);
    const removeLabel = databaseNetwork
      ? "remove the staged .env and overlay"
      : "remove the staged .env";
    try {
      for (const [uploadPath, body] of uploads) {
        await uploadRemoteContent(credentials, body, uploadPath, 0o600);
      }
    } catch (err) {
      // A partial or timed-out upload may have left a file behind.
      await bestEffort(removeLabel, () =>
        executeRemoteCommand(
          credentials,
          `rm -f ${uploadPaths.map(shq).join(" ")}`,
          REMOVE_STAGED_TIMEOUT_MS
        )
      );
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Uploading .env failed: ${message}`);
    }
    stagedPaths = uploadPaths;
    // The count only: variable names and values never reach the run output.
    // The script prints `Wrote .env (N variables)` once it is installed.
    await appendRunOutput(
      runId,
      databaseNetwork
        ? `Staged .env (${managedVars.length} variables) and ${COMPOSE_OVERLAY_FILE} (${databaseNetwork})`
        : `Staged .env (${managedVars.length} variables)`
    );
  }

  let output: string;
  try {
    // From here the server may run this tag, even if the deploy then fails.
    // Not best-effort: if it cannot be recorded, do not touch the server.
    await markScriptStarted(deploymentId);

    await appendRunOutput(
      runId,
      `Deploying ${target.componentKey} ${deployment.tag} to ${target.deployDir}`
    );
    output = await executeRemoteCommand(
      credentials,
      script,
      DEPLOY_COMMAND_TIMEOUT_MS
    );
  } catch (err) {
    // The script never ran, or failed. Either way the staged file is no longer
    // wanted: after an install it is gone already (rm -f is a no-op), and a
    // script still waiting on the lock then fails its install instead of
    // installing a file from a deploy that was given up on.
    if (stagedPaths.length > 0) {
      const remove = `rm -f ${stagedPaths.map(shq).join(" ")}`;
      await bestEffort("remove the staged files", () =>
        executeRemoteCommand(credentials, remove, REMOVE_STAGED_TIMEOUT_MS)
      );
    }
    throw err;
  }
  const trimmed = output.trim();
  if (trimmed) await appendRunOutput(runId, trimmed);
}

/** Renders the compose overlay; its inputs were validated when saved. */
function renderManagedOverlay(services: string[], network: string): string {
  try {
    return renderComposeOverlay(services, network);
  } catch {
    throw new DeployAborted(
      "The shared database network cannot be written to the compose overlay — check the database host in the Panel"
    );
  }
}

/**
 * Renders a managed .env. Stored variables were validated when saved, so a
 * failure here is unexpected; its detail could quote a variable, so the run
 * only gets a generic sentence.
 */
function renderManagedEnvFile(
  vars: { name: string; value: string }[],
  tags: Record<string, string>,
  registry: string,
  opts: { composeFiles?: string[] } = {}
): string {
  try {
    return renderEnvFile(vars, tags, registry, opts);
  } catch {
    throw new DeployAborted(
      "The environment's variables cannot be written to .env — check them in the Panel"
    );
  }
}

/**
 * The current values of `names` in the server's `<deployDir>/.env`, for the
 * tag variables of the other components sharing that file, so deploying one
 * component keeps the others' tags. The command carries only the variable
 * names (grep patterns), and only those lines come back — never other values.
 * A name missing from the file (or no file) is left out. Like Compose, the
 * last line wins; one pair of surrounding quotes is dropped.
 */
async function readServerTags(
  credentials: SshTarget,
  deployDir: string,
  names: string[]
): Promise<Record<string, string>> {
  const patterns = names
    .map((n) => `-e ${shq(`^${envVarNameSchema.parse(n)}=`)}`)
    .join(" ");
  // grep exits 1 when nothing matches (fine) and 2 on an error (not fine).
  const command = [
    `cd ${shq(deployDir)} || exit 1`,
    "[ -f .env ] || exit 0",
    `grep ${patterns} .env`,
    `[ "$?" -le 1 ]`,
  ].join("\n");
  const output = await executeRemoteCommand(
    credentials,
    command,
    READ_TAGS_TIMEOUT_MS
  );

  const found: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq);
    if (!names.includes(name)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === '"' || quote === "'") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    found[name] = value;
  }
  for (const [name, value] of Object.entries(found)) {
    if (!deployTagSchema.safeParse(value).success) {
      throw new DeployAborted(
        `${name} in ${deployDir}/.env on the server is not a valid deploy tag — fix it there before deploying`
      );
    }
  }
  return found;
}
