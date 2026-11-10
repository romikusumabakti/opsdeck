import { HTTPException } from "hono/http-exception";
import type { Deployment, DeployTarget } from "@/lib/db/schema";
import { announceRelease } from "@/lib/deploy/lock-release";
import {
  deploymentRunDescription,
  getTarget,
  type PlaceDeploymentResult,
  placeDeployment,
  placeDeploymentIfFlagged,
} from "@/lib/deploy/repository";
import { deployTagSchema } from "@/lib/deploy/validation";
import { enqueue } from "@/lib/queue";
import { TEARDOWN_ERRORS } from "@/lib/teardown/errors";
import { CodedHTTPException } from "@/server/errors";
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
 * engineer-only deploy API for `manual` and `rollback`).
 *
 * A new `auto` deployment supersedes the target's older queued or held `auto`
 * ones, so two quick pushes deploy only the newest build.
 *
 * While the environment's deploy lock is active, an `auto` deployment is
 * recorded as `held` and not enqueued (it deploys when the lock is released),
 * and a `manual` deployment or rollback is refused with a 409 naming the lock.
 * A lock past its expiry that the sweep has not removed yet is released first
 * (cause "expired"), so its held builds deploy before this request.
 *
 * While the environment is being deleted (lib/teardown/guard) nothing is
 * placed: an `auto` deployment comes back `skipped`, a manual deploy or
 * rollback is refused with 409 `teardownRunning`.
 */
export type RequestedDeployment =
  | { deploymentId: string; runId: string; status: "queued" }
  // A held deployment has no run until the lock is released.
  | { deploymentId: string; runId: null; status: "held" }
  // An `auto` deployment into an environment being deleted: nothing placed.
  | { deploymentId: null; runId: null; status: "skipped" };

export async function requestDeployment(
  input: DeploymentRequest
): Promise<RequestedDeployment> {
  const { target, tag } = await resolveRequest(input);
  const placed = await placeDeployment(placementInput(input, target, tag));
  return finishPlacement(target.environmentId, placed, input.trigger);
}

/**
 * requestDeployment for a target flagged to deploy its next build: places the
 * deployment only when this call cleared the flag (in the placing transaction),
 * so concurrent build notifications deploy once. Null when it did not.
 */
export async function requestFlaggedDeployment(
  input: DeploymentRequest
): Promise<RequestedDeployment | null> {
  const { target, tag } = await resolveRequest(input);
  const placed = await placeDeploymentIfFlagged(
    placementInput(input, target, tag)
  );
  if (placed.kind === "skipped") {
    if (placed.released) {
      await announceRelease(
        target.environmentId,
        "expired",
        null,
        placed.released
      );
    }
    return null;
  }
  if (placed.kind === "tearingDown") return null;
  return finishPlacement(target.environmentId, placed, input.trigger);
}

async function resolveRequest(input: DeploymentRequest) {
  const tag = deployTagSchema.parse(input.tag);
  const target = await getTarget(input.targetId);
  if (!target) throw new Error(`Deploy target ${input.targetId} not found`);
  return { target, tag };
}

function placementInput(
  input: DeploymentRequest,
  target: DeployTarget,
  tag: string
) {
  return {
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
  };
}

async function finishPlacement(
  environmentId: string,
  placed: PlaceDeploymentResult,
  trigger: Deployment["trigger"]
): Promise<RequestedDeployment> {
  if (placed.kind === "tearingDown") {
    // The build hook has nobody to tell; a person is refused.
    if (trigger === "auto") {
      return { deploymentId: null, runId: null, status: "skipped" };
    }
    throw new CodedHTTPException(
      409,
      "teardownRunning",
      TEARDOWN_ERRORS.teardownRunning
    );
  }
  if (placed.released) {
    // An expired lock the sweep had not removed yet: its held builds were
    // queued ahead of this request, so they are enqueued first.
    await announceRelease(environmentId, "expired", null, placed.released);
  }
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
