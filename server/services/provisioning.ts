import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { listAccessPolicies } from "@/lib/cloudflare/api";
import {
  ProvisioningPlanError,
  type ProvisioningStepSpec,
  planProvisioning,
} from "@/lib/provisioning/plan";
import {
  getActiveProvisionRunId,
  hasSuccessfulDeployment,
  listSteps,
  loadProvisioningConfig,
  type ProvisioningDomain,
  savePlan,
  startProvisioningRun,
} from "@/lib/provisioning/repository";
import { enqueue } from "@/lib/queue";
import { failRun } from "@/lib/run-progress";
import { TEARDOWN_ERRORS } from "@/lib/teardown/errors";
import { CodedHTTPException } from "@/server/errors";
import { callCloudflare } from "@/server/services/cloudflare-account";

const notFound = (): never => {
  throw new HTTPException(404, { message: "Not Found" });
};

// Running a deploy and provisioning share one permission (project engineer).
async function provisioningContext(environmentId: string) {
  const { session } = await requireProjectPermission(
    { environmentId },
    { deploy: ["run"] }
  );
  const config = (await loadProvisioningConfig(environmentId)) ?? notFound();
  return { userId: session.user.id, config };
}

// The plan error code is the 422 message; the client maps it to its own text.
function planOrFail(
  config: Parameters<typeof planProvisioning>[0]
): ProvisioningStepSpec[] {
  try {
    return planProvisioning(config);
  } catch (error) {
    if (error instanceof ProvisioningPlanError) {
      throw new HTTPException(422, { message: error.code });
    }
    throw error;
  }
}

// A tunnel binding whose Cloudflare objects are not all recorded yet: the DNS
// record, and the Access app when a policy is set.
function domainPending(
  domain: Pick<
    ProvisioningDomain,
    "kind" | "accessPolicyId" | "accessAppId" | "dnsRecordId"
  > | null
): boolean {
  if (domain?.kind !== "tunnel") return false;
  return (
    !domain.dnsRecordId || (!!domain.accessPolicyId && !domain.accessAppId)
  );
}

/**
 * Whether the deploys page offers provisioning: once it has steps, while the
 * environment has never deployed successfully (a new one), for a shared
 * database binding, or for a tunnel domain not yet provisioned. A running
 * legacy environment gets no panel, so one click can't redeploy every
 * target's newest build.
 */
export function showProvisioningPanel(input: {
  hasSteps: boolean;
  hasSuccessfulDeployment: boolean;
  dbKind: string | null | undefined;
  domain?: Parameters<typeof domainPending>[0];
}): boolean {
  return (
    input.hasSteps ||
    !input.hasSuccessfulDeployment ||
    input.dbKind === "shared" ||
    domainPending(input.domain ?? null)
  );
}

// The Access policy's name for the step sentence. A failing Cloudflare call
// (no account, a revoked token, an outage) must not break the panel: the
// sentence falls back to the id.
async function accessPolicyName(policyId: string): Promise<string | null> {
  try {
    const policies = await callCloudflare(listAccessPolicies);
    return policies.find((p) => p.id === policyId)?.name ?? null;
  } catch (error) {
    console.error("Failed to read Access policy names:", error);
    return null;
  }
}

/** The names the tunnel domain's step sentences show, or null. */
async function domainNames(domain: ProvisioningDomain | null | undefined) {
  if (domain?.kind !== "tunnel") return null;
  return {
    hostname: domain.hostname,
    remoteTunnelId: domain.remoteTunnelId,
    tunnelName: domain.tunnelName,
    accessPolicyId: domain.accessPolicyId,
    policyName: domain.accessPolicyId
      ? await accessPolicyName(domain.accessPolicyId)
      : null,
  };
}

/**
 * The stored steps, a dry preview of the plan from today's config, the live
 * run, whether the panel shows (showProvisioningPanel), and the names of the
 * tunnel domain's tunnel and Access policy for the sentences.
 */
export async function getProvisioning(environmentId: string) {
  const { config } = await provisioningContext(environmentId);
  let plan: ProvisioningStepSpec[] = [];
  try {
    plan = planProvisioning(config);
  } catch (error) {
    // A preview of an unplannable config is empty; POST reports the reason.
    if (!(error instanceof ProvisioningPlanError)) throw error;
  }
  const [steps, activeRunId, deployed, domain] = await Promise.all([
    listSteps(environmentId),
    getActiveProvisionRunId(environmentId),
    hasSuccessfulDeployment(environmentId),
    domainNames(config.domain),
  ]);
  const showPanel = showProvisioningPanel({
    hasSteps: steps.length > 0,
    hasSuccessfulDeployment: deployed,
    dbKind: config.db?.dbKind,
    domain: config.domain,
  });
  return { steps, plan, activeRunId, showPanel, domain };
}

/** Saves the plan, opens the run (one at a time) and queues the worker job. */
export async function startProvisioning(
  environmentId: string
): Promise<{ runId: string }> {
  const { userId, config } = await provisioningContext(environmentId);
  const specs = planOrFail(config);
  const started = await startProvisioningRun(environmentId, userId);
  if ("tearingDown" in started) {
    throw new CodedHTTPException(
      409,
      "teardownRunning",
      TEARDOWN_ERRORS.teardownRunning
    );
  }
  if ("conflict" in started) {
    throw new HTTPException(409, {
      message: "Provisioning is already running for this environment",
    });
  }
  try {
    await savePlan(environmentId, specs);
    await enqueue("provision/run.requested", {
      environmentId,
      runId: started.runId,
    });
  } catch (error) {
    // Without a job the run would stay `started` and block every retry.
    await failRun(started.runId, "Provisioning could not be started", {
      onlyIfStarted: true,
    });
    throw error;
  }
  // No params: step parameters stay out of the feed.
  try {
    await recordActivity({
      actorId: userId,
      action: "environment.provision",
      entityType: "environment",
      entityId: environmentId,
      data: { environment: config.name },
    });
  } catch (error) {
    // The run is queued; a feed entry is not worth failing the request.
    console.error("Failed to record provisioning activity:", error);
  }
  return { runId: started.runId };
}
