import {
  type AnyColumn,
  and,
  desc,
  eq,
  inArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  appComponents,
  builds,
  type Deployment,
  type DeployTargetKind,
  deployments,
  deployTargets,
  environments,
  projects,
  type Release,
  releases,
  users,
} from "@/lib/db/schema";
import { type CreateRunInput, insertRun } from "@/lib/run-progress";

/**
 * Whether a project has releases at all: a jar/static deploy target in one of
 * its environments (legacy components, spec 2026-11-11 decision 7), or
 * releases made before such a target was removed. Container-only projects
 * have neither, so their navigation offers no Releases page.
 */
export function projectReleasableSql(projectId: AnyColumn | SQL): SQL<boolean> {
  // Uncorrelated on purpose, with aliased tables: a correlated subquery
  // reading `environments` inside a select from `environments` resolves the
  // caller's column to its own row (always true), and Drizzle leaves column
  // names unqualified in single-table selects.
  const target = alias(deployTargets, "releasable_target");
  const env = alias(environments, "releasable_env");
  const release = alias(releases, "releasable_release");
  const releasableProjects = db
    .select({ projectId: env.projectId })
    .from(target)
    .innerJoin(env, eq(env.id, target.environmentId))
    .where(inArray(target.kind, ["jar", "static"]))
    .union(db.select({ projectId: release.projectId }).from(release));
  return sql<boolean>`(${projectId} in (${releasableProjects}))`;
}

/** {@link projectReleasableSql} for one project. */
export async function isProjectReleasable(projectId: string): Promise<boolean> {
  const [row] = await db.execute<{ releasable: boolean }>(
    sql`select ${projectReleasableSql(sql`${projectId}::uuid`)} as releasable`
  );
  return Boolean(row?.releasable);
}

/** What a release is made from: one deployment, its target and its build. */
export type ReleaseSource = {
  deploymentId: string;
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  status: Deployment["status"];
  tag: string;
  componentKey: string;
  targetKind: DeployTargetKind;
  // Null when the Panel has no build row for the deployed tag.
  branch: string | null;
  commitSha: string | null;
};

export async function getReleaseSource(
  deploymentId: string
): Promise<ReleaseSource | null> {
  const [row] = await db
    .select({
      deploymentId: deployments.id,
      environmentId: deployments.environmentId,
      environmentName: environments.name,
      projectId: environments.projectId,
      projectName: projects.name,
      status: deployments.status,
      tag: deployments.tag,
      componentKey: deployTargets.componentKey,
      targetKind: deployTargets.kind,
      branch: builds.branch,
      commitSha: builds.commitSha,
    })
    .from(deployments)
    .innerJoin(deployTargets, eq(deployTargets.id, deployments.targetId))
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    // By (component, tag), not deployments.build_id: a rollback may carry no
    // build id, and the tag names exactly one build of the component.
    .leftJoin(
      builds,
      and(
        eq(builds.componentKey, deployTargets.componentKey),
        eq(builds.tag, deployments.tag)
      )
    )
    .where(eq(deployments.id, deploymentId));
  return row ?? null;
}

export type NewReleaseRow = Pick<
  Release,
  | "projectId"
  | "componentKey"
  | "environmentId"
  | "environmentName"
  | "deploymentId"
  | "branch"
  | "tag"
  | "commitSha"
  | "version"
  | "notes"
  | "createdBy"
>;

/**
 * Inserts a `preparing` release and its run in one transaction. A version
 * already used by a release of the component that is not `failed` surfaces as
 * a unique violation (releases_version_idx).
 */
export async function insertReleaseWithRun(
  release: NewReleaseRow,
  run: CreateRunInput
): Promise<{ releaseId: string; runId: string }> {
  return db.transaction(async (tx) => {
    const row = one(
      await tx
        .insert(releases)
        .values({ ...release, status: "preparing" })
        .returning({ id: releases.id }),
      "release"
    );
    const runId = await insertRun(tx, run);
    return { releaseId: row.id, runId };
  });
}

export type ReleaseWithProject = Release & { projectName: string };

export async function getRelease(
  id: string
): Promise<ReleaseWithProject | null> {
  const [row] = await db
    .select({ release: releases, projectName: projects.name })
    .from(releases)
    .innerJoin(projects, eq(projects.id, releases.projectId))
    .where(eq(releases.id, id));
  return row ? { ...row.release, projectName: row.projectName } : null;
}

/** A release as the Releases list shows it. */
export type ReleaseRow = Release & { createdByName: string | null };

/** The project's releases, newest first. */
export async function listProjectReleases(
  projectId: string
): Promise<ReleaseRow[]> {
  const rows = await db
    .select({ release: releases, createdByName: users.name })
    .from(releases)
    .leftJoin(users, eq(users.id, releases.createdBy))
    .where(eq(releases.projectId, projectId))
    .orderBy(desc(releases.createdAt), desc(releases.id));
  return rows.map((r) => ({ ...r.release, createdByName: r.createdByName }));
}

export async function setReleaseNotes(
  id: string,
  notes: string | null
): Promise<Release | null> {
  const [row] = await db
    .update(releases)
    .set({ notes })
    .where(eq(releases.id, id))
    .returning();
  return row ?? null;
}

/** Deletes the row; returns the file key it held at that moment (or null). */
export async function deleteReleaseRow(
  id: string
): Promise<{ objectKey: string | null }> {
  const [row] = await db
    .delete(releases)
    .where(eq(releases.id, id))
    .returning({ objectKey: releases.objectKey });
  return { objectKey: row?.objectKey ?? null };
}

/** What the preparation job needs: the release, its image and target kind. */
export type ReleaseJobSubject = Release & {
  bundleImage: string;
  // Null when the deployment (or its target) is gone.
  targetKind: DeployTargetKind | null;
};

export async function getReleaseJobSubject(
  id: string
): Promise<ReleaseJobSubject | null> {
  const [row] = await db
    .select({
      release: releases,
      bundleImage: appComponents.bundleImage,
      targetKind: deployTargets.kind,
    })
    .from(releases)
    .innerJoin(
      appComponents,
      eq(appComponents.componentKey, releases.componentKey)
    )
    .leftJoin(deployments, eq(deployments.id, releases.deploymentId))
    .leftJoin(deployTargets, eq(deployTargets.id, deployments.targetId))
    .where(eq(releases.id, id));
  return row
    ? {
        ...row.release,
        bundleImage: row.bundleImage,
        targetKind: row.targetKind,
      }
    : null;
}

/** False when the release is gone or no longer `preparing`. */
export async function markReleaseReady(
  id: string,
  file: {
    objectKey: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
  }
): Promise<boolean> {
  const rows = await db
    .update(releases)
    .set({ ...file, status: "ready", error: null, readyAt: new Date() })
    .where(and(eq(releases.id, id), eq(releases.status, "preparing")))
    .returning({ id: releases.id });
  return rows.length > 0;
}

/** False when the release is gone or no longer `preparing`. */
export async function markReleaseFailed(
  id: string,
  error: string
): Promise<boolean> {
  const rows = await db
    .update(releases)
    .set({ status: "failed", error })
    .where(and(eq(releases.id, id), eq(releases.status, "preparing")))
    .returning({ id: releases.id });
  return rows.length > 0;
}
