import { z } from "zod";
import { findAutoTargets, insertBuildIfNew } from "@/lib/deploy/repository";
import {
  appKeySchema,
  branchSchema,
  commitShaSchema,
  deployTagSchema,
} from "@/lib/deploy/validation";
import { requestDeployment } from "@/server/services/deployments";

/** The body CI posts to /api/deploy-hooks/builds after pushing an image. */
export const buildNotificationSchema = z.object({
  app: appKeySchema,
  branch: branchSchema,
  tag: deployTagSchema,
  commit: commitShaSchema,
  // Shown as a link in the Panel, so only http(s).
  pipelineUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
});

export type BuildNotification = z.infer<typeof buildNotificationSchema>;

/**
 * Records a build and requests an `auto` deployment for every target that
 * follows its branch. Idempotent per (app, tag): a replayed notification finds
 * the existing build and requests nothing, so CI may retry freely.
 *
 * One target failing to queue does not stop the others; the build is already
 * recorded, and the failure is logged for the operator.
 */
export async function recordBuild(n: BuildNotification): Promise<{
  buildId: string;
  created: boolean;
  deploymentIds: string[];
}> {
  const { build, created } = await insertBuildIfNew({
    appKey: n.app,
    branch: n.branch,
    tag: n.tag,
    commitSha: n.commit,
    pipelineUrl: n.pipelineUrl ?? null,
  });
  const deploymentIds: string[] = [];
  if (!created) return { buildId: build.id, created, deploymentIds };

  // Sequential on purpose: each request supersedes older queued auto
  // deployments of its target, and the order should be deterministic.
  for (const target of await findAutoTargets(n.app, n.branch)) {
    try {
      const { deploymentId } = await requestDeployment({
        targetId: target.id,
        tag: n.tag,
        trigger: "auto",
        userId: null,
        buildId: build.id,
      });
      deploymentIds.push(deploymentId);
    } catch (error) {
      console.error(
        `Failed to request auto deployment of ${n.app} ${n.tag} to target ${target.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return { buildId: build.id, created, deploymentIds };
}
