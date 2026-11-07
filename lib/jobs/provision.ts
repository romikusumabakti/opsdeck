import { HTTPException } from "hono/http-exception";
import { flagDeployNextBuild, getTarget } from "@/lib/deploy/repository";
import { loadServerCredentials } from "@/lib/environments";
import {
  accessApp,
  dnsRecord,
  tunnelRoute,
} from "@/lib/jobs/provision-cloudflare";
import {
  provisionSharedDatabase,
  redactSecrets,
} from "@/lib/provisioning/database";
import {
  type ProvisioningStepSpec,
  provisioningStepSpecSchema,
} from "@/lib/provisioning/plan";
import {
  failRunningSteps,
  findNewestBuild,
  getProvisionRun,
  listSteps,
  loadDatabaseHost,
  markStep,
} from "@/lib/provisioning/repository";
import type { JobMap } from "@/lib/queue";
import { appendRunOutput, completeRun, failRun } from "@/lib/run-progress";
import { decryptSecret } from "@/lib/secrets";
import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";
import { decodeVariableValue } from "@/lib/variables/managed-env";
import { getVariable } from "@/lib/variables/repository";
import { requestDeployment } from "@/server/services/deployments";

// Wall-clock bound on one remote command of a step.
const STEP_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** An expected failure; its message is the whole story for the step. */
class StepFailed extends Error {}

export type ProvisionJobResult = { status: "success" | "failed" };

type StepContext = {
  environmentId: string;
  runId: string;
  userId: string | null;
  // Plaintext secrets loaded by a step; scrubbed from anything stored or logged.
  secrets: string[];
};

function summarize(spec: ProvisioningStepSpec): string {
  switch (spec.kind) {
    case "prepare_deploy_dir":
      return spec.params.deployDir;
    case "create_database":
      return `${spec.params.database} (role ${spec.params.role})`;
    case "tunnel_route":
      return `${spec.params.hostname} → ${spec.params.service}`;
    case "access_app":
    case "dns_record":
      return spec.params.hostname;
    case "deploy":
      return `${spec.params.targetId} @ ${spec.params.branch}`;
  }
}

async function prepareDeployDir(
  params: Extract<
    ProvisioningStepSpec,
    { kind: "prepare_deploy_dir" }
  >["params"]
): Promise<string> {
  const creds = await loadServerCredentials(params.serverId);
  if (!creds) throw new StepFailed(`Server ${params.serverId} not found`);
  const dir = shq(params.deployDir);
  // Never chmod an existing directory: someone may have set it deliberately.
  await executeRemoteCommand(
    creds,
    `[ -d ${dir} ] || install -d -m 0750 ${dir}`,
    {
      timeoutMs: STEP_COMMAND_TIMEOUT_MS,
    }
  );
  return `Deploy directory ${params.deployDir} ready`;
}

async function createDatabase(
  ctx: StepContext,
  params: Extract<ProvisioningStepSpec, { kind: "create_database" }>["params"]
): Promise<string> {
  const variable = await getVariable(
    ctx.environmentId,
    params.passwordVariable
  );
  if (!variable || variable.kind === "plain" || !variable.value) {
    throw new StepFailed(`variable ${params.passwordVariable} missing`);
  }
  const password = decodeVariableValue(variable);
  if (!password) {
    throw new StepFailed(`variable ${params.passwordVariable} missing`);
  }
  ctx.secrets.push(password);
  const host = await loadDatabaseHost(params.databaseHostId);
  if (!host) {
    throw new StepFailed(`Database host ${params.databaseHostId} not found`);
  }
  await provisionSharedDatabase(
    {
      server: { ...host.server, password: decryptSecret(host.server.password) },
      containerName: host.containerName,
    },
    {
      database: params.database,
      role: params.role,
      password,
      environmentId: ctx.environmentId,
    }
  );
  return `Database ${params.database} and role ${params.role} ready`;
}

async function deploy(
  ctx: StepContext,
  params: Extract<ProvisioningStepSpec, { kind: "deploy" }>["params"]
): Promise<string> {
  const target = await getTarget(params.targetId);
  if (!target)
    throw new StepFailed(`Deploy target ${params.targetId} not found`);
  const build = await findNewestBuild(target.componentKey, target.sourceBranch);
  if (!build) {
    // Nothing to deploy yet: the next build of the branch deploys once.
    await flagDeployNextBuild(target.id);
    return `Waiting for the first build of ${target.sourceBranch}; it deploys when it lands`;
  }
  try {
    // The provisioning run does not wait: the deploy has its own run.
    const result = await requestDeployment({
      targetId: target.id,
      tag: build.tag,
      trigger: "manual",
      userId: ctx.userId,
      buildId: build.id,
    });
    return `Deployment ${result.deploymentId} of ${build.tag} ${result.status}`;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 409) {
      throw new StepFailed(error.message);
    }
    throw error;
  }
}

async function executeStep(
  ctx: StepContext,
  spec: ProvisioningStepSpec
): Promise<string> {
  switch (spec.kind) {
    case "prepare_deploy_dir":
      return prepareDeployDir(spec.params);
    case "create_database":
      return createDatabase(ctx, spec.params);
    case "tunnel_route":
      return tunnelRoute(ctx, spec.params);
    case "access_app":
      return accessApp(ctx, spec.params);
    case "dns_record":
      return dnsRecord(ctx, spec.params);
    case "deploy":
      return deploy(ctx, spec.params);
  }
}

/**
 * Runs the environment's provisioning steps in order, skipping `done` ones.
 * A step left `running` by a crashed worker is simply retried: every step is
 * idempotent. The first failure marks that step and the run failed and stops;
 * the next run resumes from there.
 */
export async function runProvisioning(
  data: JobMap["provision/run.requested"]
): Promise<ProvisionJobResult> {
  const { environmentId, runId } = data;
  const ctx: StepContext = { environmentId, runId, userId: null, secrets: [] };
  try {
    return await runSteps(ctx);
  } catch (error) {
    // Anything that escaped (a lost database connection, a missing run) would
    // leave the run `started` and answer every retry with a 409. Close it,
    // best-effort, then let BullMQ record the failure.
    const raw = error instanceof Error ? error.message : String(error);
    const message = redactSecrets(raw, ctx.secrets);
    await failRunningSteps(environmentId, message).catch(() => {});
    await failRun(runId, message, { onlyIfStarted: true }).catch(() => {});
    throw error;
  }
}

async function runSteps(ctx: StepContext): Promise<ProvisionJobResult> {
  const { environmentId, runId } = ctx;
  const run = await getProvisionRun(runId);
  if (!run) throw new Error(`Provision run ${runId} not found`);
  if (run.status !== "started") {
    // BullMQ stalled recovery can redeliver a job whose run was already
    // closed (failed by the boot sweep or the stale check, or finished).
    // Running its steps again would act outside any open run.
    console.log(
      `Provision run ${runId} is ${run.status}, not started; skipping redelivered job`
    );
    return { status: run.status === "success" ? "success" : "failed" };
  }
  ctx.userId = run.userId;

  for (const step of await listSteps(environmentId)) {
    if (step.status === "done") continue;
    let label = `${step.kind}`;
    try {
      const parsed = provisioningStepSpecSchema.safeParse({
        kind: step.kind,
        params: step.params,
      });
      if (!parsed.success) throw new StepFailed("Stored step is invalid");
      const spec = parsed.data;
      label = `${spec.kind} ${summarize(spec)}`;
      await markStep(step.id, "running", { runId });
      await appendRunOutput(runId, `▶ ${label}`);
      const message = await executeStep(ctx, spec);
      await markStep(step.id, "done", { runId });
      await appendRunOutput(runId, `✔ ${message}`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = redactSecrets(raw, ctx.secrets);
      await markStep(step.id, "failed", { error: message, runId });
      await appendRunOutput(runId, `✖ ${label}: ${message}`);
      await failRun(runId, message, { onlyIfStarted: true });
      return { status: "failed" };
    }
  }
  await appendRunOutput(runId, "Provisioning complete");
  if (!(await completeRun(runId, { onlyIfStarted: true }))) {
    // Closed under us (e.g. the stale check failed it): leave it failed.
    console.log(`Provision run ${runId} was closed before it completed`);
    return { status: "failed" };
  }
  return { status: "success" };
}
