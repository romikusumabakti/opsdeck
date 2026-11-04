import type { Deployment } from "@/lib/db/schema";
import {
  getTarget,
  insertDeployment,
  supersedeQueuedAuto,
} from "@/lib/deploy/repository";
import { deployTagSchema } from "@/lib/deploy/validation";
import { enqueue } from "@/lib/queue";
import { createRun } from "@/lib/run-progress";

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
 * A new `auto` deployment supersedes the target's older queued `auto` ones, so
 * two quick pushes deploy only the newest build.
 */
export async function requestDeployment(
  input: DeploymentRequest
): Promise<{ deploymentId: string; runId: string }> {
  const tag = deployTagSchema.parse(input.tag);
  const target = await getTarget(input.targetId);
  if (!target) throw new Error(`Deploy target ${input.targetId} not found`);

  const runId = await createRun({
    environmentId: target.environmentId,
    userId: input.userId,
    description: `Deploy ${target.componentKey} ${tag} (${input.trigger})`,
    kind: "deploy",
  });
  const deployment = await insertDeployment({
    targetId: target.id,
    environmentId: target.environmentId,
    runId,
    tag,
    trigger: input.trigger,
    buildId: input.buildId,
  });
  if (input.trigger === "auto") {
    await supersedeQueuedAuto(target.id, deployment.id);
  }
  await enqueue("deploy/run.requested", {
    deploymentId: deployment.id,
    runId,
  });
  return { deploymentId: deployment.id, runId };
}
