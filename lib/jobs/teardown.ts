import {
  type CloudflareCreds,
  deleteAccessApp,
  deleteDnsRecord,
  getTunnelConfig,
  putTunnelConfig,
  withoutIngressRoute,
} from "@/lib/cloudflare/api";
import { getRemoteTunnel, getZoneCloudflareId } from "@/lib/domains/repository";
import { withAdvisoryXactLock } from "@/lib/provisioning/repository";
import type { JobMap } from "@/lib/queue";
import { appendRunOutput, completeRun, failRun } from "@/lib/run-progress";
import { redactSecrets } from "@/lib/ssh";
import { HostKeyMismatchError } from "@/lib/ssh-connect";
import {
  type ArchiveContext,
  archiveDatabase,
  archiveDeployDir,
  archiveVolumes,
} from "@/lib/teardown/archive";
import { StepFailed, type TeardownErrorCode } from "@/lib/teardown/errors";
import {
  type TeardownStepSpec,
  teardownStepSpecSchema,
} from "@/lib/teardown/plan";
import {
  deleteTeardownEnvironment,
  environmentExists,
  failRunningTeardownSteps,
  getTeardownRun,
  listTeardownSteps,
  markTeardownStep,
} from "@/lib/teardown/repository";
import {
  checkStack,
  dropDatabase,
  removeDeployDir,
  stackDown,
  stopStack,
} from "@/lib/teardown/server-steps";
import { loadCloudflareAccount } from "@/server/services/cloudflare-account";

// Runs an environment's teardown steps (lib/teardown/plan) in order, as
// runProvisioning runs provisioning: `done` steps are skipped, a step left
// `running` by a crashed worker is retried (every step is idempotent), and the
// first failure marks that step failed with its stable code, fails the run
// and stops; the next run resumes there. The last step deletes the
// environment, and with it (cascade) its steps and this run.

export type TeardownJobResult = { status: "success" | "failed" };

type Params<K extends TeardownStepSpec["kind"]> = Extract<
  TeardownStepSpec,
  { kind: K }
>["params"];

function summarize(spec: TeardownStepSpec): string {
  switch (spec.kind) {
    case "check_stack":
    case "stop_stack":
    case "archive_deploy_dir":
    case "archive_volumes":
    case "stack_down":
    case "remove_deploy_dir":
      return spec.params.deployDir;
    case "archive_database":
    case "drop_database":
      return spec.params.serviceId;
    case "remove_tunnel_route":
      return spec.params.hostname;
    case "remove_access_app":
      return spec.params.appId;
    case "remove_dns_record":
      return spec.params.recordId;
    case "delete_environment":
      return "";
  }
}

/** The step's stable code for an error (StepFailed's, else a generic one). */
function errorCode(error: unknown): TeardownErrorCode {
  if (error instanceof StepFailed) return error.code;
  if (error instanceof HostKeyMismatchError) return "serverCommandFailed";
  return "stepFailed";
}

async function cloudflare(ctx: ArchiveContext): Promise<CloudflareCreds> {
  const account = await loadCloudflareAccount();
  if (!account) {
    throw new StepFailed(
      "cloudflareFailed",
      "the Cloudflare account is not set up"
    );
  }
  ctx.secrets.push(account.creds.apiToken);
  return account.creds;
}

/** Runs a Cloudflare removal; any error but a StepFailed is cloudflareFailed. */
async function onCloudflare(
  ctx: ArchiveContext,
  fn: () => Promise<string>
): Promise<string> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof StepFailed) throw error;
    const raw = error instanceof Error ? error.message : String(error);
    throw new StepFailed("cloudflareFailed", redactSecrets(raw, ctx.secrets));
  }
}

async function zoneId(zoneRowId: string): Promise<string> {
  const id = await getZoneCloudflareId(zoneRowId);
  if (!id)
    throw new StepFailed("cloudflareFailed", `zone ${zoneRowId} not found`);
  return id;
}

function removeDnsRecord(
  ctx: ArchiveContext,
  params: Params<"remove_dns_record">
): Promise<string> {
  return onCloudflare(ctx, async () => {
    const creds = await cloudflare(ctx);
    const zone = await zoneId(params.zoneId);
    const result = await deleteDnsRecord(creds, zone, params.recordId);
    return result === "deleted"
      ? `DNS record ${params.recordId} deleted`
      : `DNS record ${params.recordId} already gone`;
  });
}

/**
 * Takes the hostname's rule out of the tunnel's remote config. The GET, the
 * edit and the PUT run under the tunnel's advisory lock (as provisioning's
 * route step), and the config is only written when a rule was removed.
 */
function removeTunnelRoute(
  ctx: ArchiveContext,
  params: Params<"remove_tunnel_route">
): Promise<string> {
  return onCloudflare(ctx, async () => {
    const creds = await cloudflare(ctx);
    const tunnel = await getRemoteTunnel(params.remoteTunnelId);
    if (!tunnel) {
      throw new StepFailed(
        "cloudflareFailed",
        `remote tunnel ${params.remoteTunnelId} not found`
      );
    }
    const removed = await withAdvisoryXactLock(
      `cf-tunnel:${tunnel.tunnelId}`,
      async () => {
        const current = await getTunnelConfig(creds, tunnel.tunnelId);
        const next = withoutIngressRoute(current, params.hostname);
        if (next.removed) {
          await putTunnelConfig(creds, tunnel.tunnelId, next.config);
        }
        return next.removed;
      }
    );
    return removed
      ? `Route ${params.hostname} removed from ${tunnel.name}`
      : `Route ${params.hostname} already gone from ${tunnel.name}`;
  });
}

/** The Access app, in the Cloudflare account the Panel uses for the zone. */
function removeAccessApp(
  ctx: ArchiveContext,
  params: Params<"remove_access_app">
): Promise<string> {
  return onCloudflare(ctx, async () => {
    const creds = await cloudflare(ctx);
    const result = await deleteAccessApp(creds, creds.accountId, params.appId);
    return result === "deleted"
      ? `Access app ${params.appId} deleted`
      : `Access app ${params.appId} already gone`;
  });
}

/**
 * Deletes the environment row (its steps and runs go with it), closes the
 * archive and records `environment.deleted`, in one transaction. Refused
 * (the escrow code) while the environment has escrowed variables the start
 * did not confirm.
 */
async function deleteEnvironment(
  ctx: ArchiveContext,
  params: Params<"delete_environment">
): Promise<string> {
  const deleted = await deleteTeardownEnvironment(
    ctx.environmentId,
    ctx.userId,
    { escrowConfirmed: params.confirmEscrowedDeletion === true }
  );
  if (!deleted) return "Environment already deleted";
  if ("refusal" in deleted) throw new StepFailed(deleted.refusal);
  return `Environment ${deleted.environmentName} deleted`;
}

function executeStep(
  ctx: ArchiveContext,
  spec: TeardownStepSpec
): Promise<string> {
  switch (spec.kind) {
    case "check_stack":
      return checkStack(ctx, spec.params);
    case "archive_database":
      return archiveDatabase(ctx, spec.params);
    case "stop_stack":
      return stopStack(ctx, spec.params);
    case "archive_deploy_dir":
      return archiveDeployDir(ctx, spec.params);
    case "archive_volumes":
      return archiveVolumes(ctx, spec.params);
    case "stack_down":
      return stackDown(ctx, spec.params);
    case "drop_database":
      return dropDatabase(ctx, spec.params);
    case "remove_dns_record":
      return removeDnsRecord(ctx, spec.params);
    case "remove_tunnel_route":
      return removeTunnelRoute(ctx, spec.params);
    case "remove_access_app":
      return removeAccessApp(ctx, spec.params);
    case "remove_deploy_dir":
      return removeDeployDir(ctx, spec.params);
    case "delete_environment":
      return deleteEnvironment(ctx, spec.params);
  }
}

export async function runTeardown(
  data: JobMap["environment/teardown.requested"]
): Promise<TeardownJobResult> {
  const { environmentId, runId } = data;
  const ctx: ArchiveContext = {
    environmentId,
    runId,
    userId: null,
    secrets: [],
  };
  try {
    return await runSteps(ctx);
  } catch (error) {
    // Anything that escaped (a lost database connection, a missing run) would
    // leave the run `started` and refuse every retry as teardownRunning.
    // Close it, best-effort, then let BullMQ record the failure.
    const raw = error instanceof Error ? error.message : String(error);
    const message = redactSecrets(raw, ctx.secrets);
    await failRunningTeardownSteps(environmentId, "stepFailed").catch(() => {});
    await failRun(runId, message, { onlyIfStarted: true }).catch(() => {});
    throw error;
  }
}

async function runSteps(ctx: ArchiveContext): Promise<TeardownJobResult> {
  const { environmentId, runId } = ctx;
  const run = await getTeardownRun(runId);
  if (!run) {
    // A job redelivered after its delete_environment committed: the run went
    // with the environment, and the teardown is done.
    if (!(await environmentExists(environmentId))) {
      console.log(
        `Teardown run ${runId} is gone with its environment; skipping redelivered job`
      );
      return { status: "success" };
    }
    throw new Error(`Teardown run ${runId} not found`);
  }
  if (run.status !== "started") {
    // BullMQ stalled recovery can redeliver a job whose run was already
    // closed. Running its steps again would act outside any open run.
    console.log(
      `Teardown run ${runId} is ${run.status}, not started; skipping redelivered job`
    );
    return { status: run.status === "success" ? "success" : "failed" };
  }
  ctx.userId = run.userId;

  for (const step of await listTeardownSteps(environmentId)) {
    if (step.status === "done") continue;
    let label = `${step.kind}`;
    try {
      const parsed = teardownStepSpecSchema.safeParse({
        kind: step.kind,
        params: step.params,
      });
      if (!parsed.success) {
        throw new StepFailed("stepFailed", "the stored step is invalid");
      }
      const spec = parsed.data;
      const summary = summarize(spec);
      label = summary ? `${spec.kind} ${summary}` : spec.kind;
      await markTeardownStep(step.id, "running", { runId });
      await appendRunOutput(runId, `▶ ${label}`);
      const message = await executeStep(ctx, spec);
      if (spec.kind === "delete_environment") {
        // The environment's steps and this run went with it: nothing is
        // left to mark, and the deletion is the success.
        console.log(`Teardown run ${runId}: ${message}`);
        return { status: "success" };
      }
      await markTeardownStep(step.id, "done", { runId });
      await appendRunOutput(runId, `✔ ${message}`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = redactSecrets(raw, ctx.secrets);
      await markTeardownStep(step.id, "failed", {
        error: errorCode(error),
        runId,
      });
      await appendRunOutput(runId, `✖ ${label}: ${message}`);
      await failRun(runId, message, { onlyIfStarted: true });
      return { status: "failed" };
    }
  }
  await appendRunOutput(runId, "Teardown complete");
  if (!(await completeRun(runId, { onlyIfStarted: true }))) {
    console.log(`Teardown run ${runId} was closed before it completed`);
    return { status: "failed" };
  }
  return { status: "success" };
}
