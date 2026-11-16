import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  appComponents,
  builds,
  deployments,
  deployTargets,
} from "@/lib/db/schema";

/**
 * One code source the assistant may read for an environment: a component's
 * repository at the commit actually running there. Three states:
 * - deployed, `commitSha` set: `ref` is that commit.
 * - deployed, `commitSha` null: a deployment succeeded but its build (and so
 *   its commit) cannot be resolved, e.g. legacy artifact targets; `ref` is the
 *   source branch, to be resolved to its head by the caller.
 * - not deployed (`deployed` false): no deployment ever succeeded; `ref` is the
 *   source branch, to be resolved to its head by the caller.
 */
export type AssistantSource = {
  componentKey: string;
  repoFullName: string;
  ciConnectionId: string | null;
  commitSha: string | null;
  ref: string;
  deployed: boolean;
  deployedAt: string | null;
};

type DeploymentRow = {
  status: string;
  buildId: string | null;
  tag: string;
  createdAt: Date;
  finishedAt: Date | null;
};

type BuildRow = {
  id: string;
  tag: string;
  commitSha: string;
  receivedAt: Date;
};

const deployedAtOf = (d: DeploymentRow) => d.finishedAt ?? d.createdAt;

/**
 * The commit a target runs: its newest successful deployment, through the
 * linked build or, when the link is gone, the newest build of that tag.
 * Null when nothing succeeded. When the newest success has no findable build
 * the commit is null but deployedAt is still set (older deployments are not
 * what runs, so they are not a fallback).
 */
export function pickRunningCommit(
  deploymentRows: DeploymentRow[],
  buildRows: BuildRow[]
): { commitSha: string | null; deployedAt: string } | null {
  const newest = deploymentRows
    .filter((d) => d.status === "success")
    .sort((a, b) => deployedAtOf(b).getTime() - deployedAtOf(a).getTime())[0];
  if (!newest) return null;

  const build = newest.buildId
    ? buildRows.find((b) => b.id === newest.buildId)
    : buildRows
        .filter((b) => b.tag === newest.tag)
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];

  return {
    commitSha: build?.commitSha ?? null,
    deployedAt: deployedAtOf(newest).toISOString(),
  };
}

/** Every deploy target of the environment with the commit it runs. */
export async function resolveEnvironmentSources(
  environmentId: string
): Promise<AssistantSource[]> {
  const targets = await db
    .select({
      id: deployTargets.id,
      componentKey: deployTargets.componentKey,
      sourceBranch: deployTargets.sourceBranch,
      repoFullName: appComponents.repoFullName,
      ciConnectionId: appComponents.ciConnectionId,
    })
    .from(deployTargets)
    .innerJoin(
      appComponents,
      eq(appComponents.componentKey, deployTargets.componentKey)
    )
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(deployTargets.componentKey, deployTargets.id);
  if (targets.length === 0) return [];

  const succeeded = await db
    .select()
    .from(deployments)
    .where(
      and(
        inArray(
          deployments.targetId,
          targets.map((t) => t.id)
        ),
        eq(deployments.status, "success")
      )
    );
  const componentKeys = [...new Set(targets.map((t) => t.componentKey))];
  const buildRows = await db
    .select()
    .from(builds)
    .where(inArray(builds.componentKey, componentKeys));

  return targets.map((t) => {
    const running = pickRunningCommit(
      succeeded.filter((d) => d.targetId === t.id),
      buildRows.filter((b) => b.componentKey === t.componentKey)
    );
    return {
      componentKey: t.componentKey,
      repoFullName: t.repoFullName,
      ciConnectionId: t.ciConnectionId,
      commitSha: running?.commitSha ?? null,
      ref: running?.commitSha ?? t.sourceBranch,
      deployed: running !== null,
      deployedAt: running?.deployedAt ?? null,
    };
  });
}
