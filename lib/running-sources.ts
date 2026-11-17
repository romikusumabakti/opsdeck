import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  appComponents,
  builds,
  deployments,
  deployTargets,
} from "@/lib/db/schema";

/**
 * What one deploy target of an environment runs: a component's repository at
 * the commit actually running there, and the tag that deployed it. Read by the
 * dashboard's Running card and, without the tag, by the code assistant
 * (lib/assistant/sources). Three states:
 * - deployed, `commitSha` set: `ref` is that commit.
 * - deployed, `commitSha` null: a deployment succeeded but its build (and so
 *   its commit) cannot be resolved, e.g. legacy artifact targets; `ref` is the
 *   source branch, to be resolved to its head by the caller.
 * - not deployed (`deployed` false): no deployment ever succeeded; `ref` is the
 *   source branch, to be resolved to its head by the caller.
 */
export type RunningSource = {
  componentKey: string;
  repoFullName: string;
  ciConnectionId: string | null;
  commitSha: string | null;
  /** The newest successful deployment's tag; null when never deployed. */
  tag: string | null;
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
 * The commit and tag a target runs: its newest successful deployment, through the
 * linked build or, when the link is gone, the newest build of that tag.
 * Null when nothing succeeded. When the newest success has no findable build
 * the commit is null but deployedAt is still set (older deployments are not
 * what runs, so they are not a fallback).
 */
export function pickRunningCommit(
  deploymentRows: DeploymentRow[],
  buildRows: BuildRow[]
): { commitSha: string | null; tag: string; deployedAt: string } | null {
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
    tag: newest.tag,
    deployedAt: deployedAtOf(newest).toISOString(),
  };
}

/** Every deploy target of the environment with the commit it runs. */
export async function resolveRunningSources(
  environmentId: string
): Promise<RunningSource[]> {
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

  // Only what runs: the newest successful deployment per target (the same
  // order pickRunningCommit applies), then only the builds those deployments
  // name, by id or, without one, by their component's tag.
  const deployedAt = sql`coalesce(${deployments.finishedAt}, ${deployments.createdAt})`;
  const succeeded = await db
    .selectDistinctOn([deployments.targetId], {
      targetId: deployments.targetId,
      status: deployments.status,
      buildId: deployments.buildId,
      tag: deployments.tag,
      createdAt: deployments.createdAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .where(
      and(
        inArray(
          deployments.targetId,
          targets.map((t) => t.id)
        ),
        eq(deployments.status, "success")
      )
    )
    .orderBy(deployments.targetId, desc(deployedAt), desc(deployments.id));

  const componentOf = new Map(targets.map((t) => [t.id, t.componentKey]));
  const buildIds = succeeded.flatMap((d) => (d.buildId ? [d.buildId] : []));
  const byTag = succeeded.flatMap((d) => {
    const componentKey = componentOf.get(d.targetId);
    return !d.buildId && componentKey
      ? [and(eq(builds.componentKey, componentKey), eq(builds.tag, d.tag))]
      : [];
  });
  const buildRows =
    buildIds.length + byTag.length === 0
      ? []
      : await db
          .select({
            id: builds.id,
            componentKey: builds.componentKey,
            tag: builds.tag,
            commitSha: builds.commitSha,
            receivedAt: builds.receivedAt,
          })
          .from(builds)
          .where(
            or(
              ...(buildIds.length > 0 ? [inArray(builds.id, buildIds)] : []),
              ...byTag
            )
          );

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
      tag: running?.tag ?? null,
      ref: running?.commitSha ?? t.sourceBranch,
      deployed: running !== null,
      deployedAt: running?.deployedAt ?? null,
    };
  });
}
