import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import {
  ProvisioningPlanError,
  type ProvisioningStepSpec,
  planProvisioning,
} from "@/lib/provisioning/plan";
import {
  getActiveProvisionRunId,
  listSteps,
  loadProvisioningConfig,
  savePlan,
  startProvisioningRun,
} from "@/lib/provisioning/repository";
import { enqueue } from "@/lib/queue";
import { failRun } from "@/lib/run-progress";

const notFound = (): never => {
  throw new HTTPException(404, { message: "Not Found" });
};

// Running a deploy and provisioning share one permission (project maintainer).
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

/** The stored steps, a dry preview of the plan from today's config, the live run. */
export async function getProvisioning(environmentId: string) {
  const { config } = await provisioningContext(environmentId);
  let plan: ProvisioningStepSpec[] = [];
  try {
    plan = planProvisioning(config);
  } catch (error) {
    // A preview of an unplannable config is empty; POST reports the reason.
    if (!(error instanceof ProvisioningPlanError)) throw error;
  }
  const [steps, activeRunId] = await Promise.all([
    listSteps(environmentId),
    getActiveProvisionRunId(environmentId),
  ]);
  return { steps, plan, activeRunId };
}

/** Saves the plan, opens the run (one at a time) and queues the worker job. */
export async function startProvisioning(
  environmentId: string
): Promise<{ runId: string }> {
  const { userId, config } = await provisioningContext(environmentId);
  const specs = planOrFail(config);
  const started = await startProvisioningRun(environmentId, userId);
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
    await failRun(started.runId, "Provisioning could not be started");
    throw error;
  }
  // No params: step parameters stay out of the feed.
  await recordActivity({
    actorId: userId,
    action: "environment.provision",
    entityType: "environment",
    entityId: environmentId,
    data: { environment: config.name },
  });
  return { runId: started.runId };
}
