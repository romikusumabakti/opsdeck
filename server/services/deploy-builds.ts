import { z } from "zod";
import { getComponent } from "@/lib/apps";
import { parsePipelineNumber } from "@/lib/ci/woodpecker";
import {
  findAutoTargets,
  findNextBuildTargets,
  insertBuildIfNew,
} from "@/lib/deploy/repository";
import {
  branchSchema,
  commitShaSchema,
  componentKeySchema,
  deployTagSchema,
} from "@/lib/deploy/validation";
import { getProviderForConnection } from "@/server/services/ci-connections";
import {
  requestDeployment,
  requestFlaggedDeployment,
} from "@/server/services/deployments";

/** The body CI posts to /api/deploy-hooks/builds after pushing an image. */
export const buildNotificationSchema = z.object({
  // The field keeps its name (`app`): pipelines on several repos send it today.
  // Its value is the component key.
  app: componentKeySchema,
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

/** The longest a build notification waits for the CI provider. */
export const BUILD_ACTORS_TIMEOUT_MS = 5_000;

/** What the lookup needs of a build notification or a stored build. */
export type BuildActorsInput = Pick<BuildNotification, "app" | "tag"> & {
  pipelineUrl?: string | null;
};

type BuildActors = {
  pushedBy: string | null;
  commitAuthorEmail: string | null;
  commitMessage: string | null;
};

const NO_ACTORS: BuildActors = {
  pushedBy: null,
  commitAuthorEmail: null,
  commitMessage: null,
};

const clip = (value: string | null, max: number) =>
  value === null ? null : value.slice(0, max);

/**
 * Who pushed the build, read from the component's own CI connection and repo.
 * The pipeline number comes from the notified `pipelineUrl`, used only when it
 * points at that repo, so a notification cannot make the Panel read another
 * repo's pipeline.
 */
async function fetchBuildActors(n: BuildActorsInput): Promise<BuildActors> {
  const component = await getComponent(n.app);
  if (!component?.ciConnectionId) return NO_ACTORS;
  const number = parsePipelineNumber(n.pipelineUrl, component.ciRepoId);
  if (number === null || !component.ciRepoId) return NO_ACTORS;
  const provider = await getProviderForConnection(component.ciConnectionId);
  const pipeline = await provider.getPipeline(component.ciRepoId, number);
  return {
    pushedBy: clip(pipeline.sender, 200),
    // RFC 5321 caps an address at 254; a little slack for odd forges.
    commitAuthorEmail: clip(pipeline.authorEmail, 320),
    commitMessage: clip(pipeline.message, 500),
  };
}

/**
 * fetchBuildActors, best-effort: any failure, or no answer within
 * BUILD_ACTORS_TIMEOUT_MS, gives nulls so the build and its deployments are
 * recorded as without it. Logs the reason only (CiProviderError messages hold
 * no credentials).
 */
export async function buildActorsOrNulls(
  n: BuildActorsInput
): Promise<BuildActors> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out")),
      BUILD_ACTORS_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([fetchBuildActors(n), timeout]);
  } catch (error) {
    console.warn(
      `Build ${n.app} ${n.tag}: who pushed it is unknown:`,
      error instanceof Error ? error.message : "unexpected error"
    );
    return NO_ACTORS;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records a build and requests an `auto` deployment for every target that
 * follows its branch. Who pushed it is looked up first (best-effort, at most
 * BUILD_ACTORS_TIMEOUT_MS) and stored on the build; its auto runs carry it. Idempotent per (app, tag): a replayed notification finds
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
    componentKey: n.app,
    branch: n.branch,
    tag: n.tag,
    commitSha: n.commit,
    pipelineUrl: n.pipelineUrl ?? null,
    ...(await buildActorsOrNulls(n)),
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
  // Targets flagged to deploy their next build (the setup wizard, a first
  // build that did not exist yet) deploy this one, once: the flag is cleared
  // in the placing transaction, and only the call that cleared it places.
  // Flagged auto targets are not listed here: their auto deployment above
  // already cleared the flag.
  for (const target of await findNextBuildTargets(n.app, n.branch)) {
    try {
      const requested = await requestFlaggedDeployment({
        targetId: target.id,
        tag: n.tag,
        trigger: "auto",
        userId: null,
        buildId: build.id,
      });
      if (requested) deploymentIds.push(requested.deploymentId);
    } catch (error) {
      console.error(
        `Failed to request first deployment of ${n.app} ${n.tag} to target ${target.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return { buildId: build.id, created, deploymentIds };
}
