import { HTTPException } from "hono/http-exception";
import type { Deployment } from "@/lib/db/schema";
import {
  deploymentRunDescription,
  getTarget,
  placeDeployment,
} from "@/lib/deploy/repository";
import { deployTagSchema } from "@/lib/deploy/validation";
import { enqueue } from "@/lib/queue";
import { deployLockedMessage } from "@/server/services/deploy-locks";

export type DeploymentRequest = {
  targetId: string;
  tag: string;
  trigger: Deployment["trigger"];
  userId: string | null;
  buildId: string | null;
};

/**
 * Records a deployment of `tag` to a target and queues it. No permission check
 * here: the callers own it (the signed build hook for `auto`, the
 * maintainer-only deploy API for `manual` and `rollback`).
 *
 * A new `auto` deployment supersedes the target's older queued or held `auto`
 * ones, so two quick pushes deploy only the newest build.
 *
 * While the environment's deploy lock is active, an `auto` deployment is
 * recorded as `held` and not enqueued (it deploys when the lock is released),
 * and a `manual` deployment or rollback is refused with a 409 naming the lock.
 */
export type RequestedDeployment =
  | { deploymentId: string; runId: string; status: "queued" }
  // A held deployment has no run until the lock is released.
  | { deploymentId: string; runId: null; status: "held" };

export async function requestDeployment(
  input: DeploymentRequest
): Promise<RequestedDeployment> {
  const tag = deployTagSchema.parse(input.tag);
  const target = await getTarget(input.targetId);
  if (!target) throw new Error(`Deploy target ${input.targetId} not found`);

  const placed = await placeDeployment({
    targetId: target.id,
    environmentId: target.environmentId,
    tag,
    trigger: input.trigger,
    userId: input.userId,
    buildId: input.buildId,
    description: deploymentRunDescription(
      target.componentKey,
      tag,
      input.trigger
    ),
    now: new Date(),
  });
  if (placed.kind === "locked") {
    throw new HTTPException(409, {
      message: await deployLockedMessage(placed.lock),
    });
  }
  if (placed.kind === "held") {
    return { deploymentId: placed.deploymentId, runId: null, status: "held" };
  }
  await enqueue("deploy/run.requested", {
    deploymentId: placed.deploymentId,
    runId: placed.runId,
  });
  return {
    deploymentId: placed.deploymentId,
    runId: placed.runId,
    status: "queued",
  };
}
