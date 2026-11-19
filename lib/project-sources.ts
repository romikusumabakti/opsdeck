import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import {
  appComponents,
  deployTargets,
  environments,
  projectComponentBranches,
  projectServices,
} from "@/lib/db/schema";
import { fallbackBranch } from "@/lib/setup/source-branch";

// A project's sources are its services (`project_services`, Stage 8): the
// components its environments may deploy. Legacy apps play no part here.

export type ProjectSourceEnvironment = {
  id: string;
  name: string;
  slug: string;
  /** The source branch of the environment's target of this service. */
  sourceBranch: string;
};

export type ProjectSource = {
  componentKey: string;
  repoFullName: string;
  defaultBranch: string | null;
  fallbackBranch: string;
  /** A deploy target of the project deploys it: it cannot be removed. */
  inUse: boolean;
  /** The project's environments with a target of this service. */
  environments: ProjectSourceEnvironment[];
};

/** Some environment of the project has a deploy target of the service. */
export async function serviceInUse(
  projectId: string,
  componentKey: string,
  executor: DbExecutor = db
): Promise<boolean> {
  const [target] = await executor
    .select({ environmentId: deployTargets.environmentId })
    .from(deployTargets)
    .innerJoin(environments, eq(environments.id, deployTargets.environmentId))
    .where(
      and(
        eq(environments.projectId, projectId),
        eq(deployTargets.componentKey, componentKey)
      )
    )
    .limit(1);
  return Boolean(target);
}

export async function loadProjectSources(
  projectId: string
): Promise<ProjectSource[]> {
  const [serviceRows, defaults, targets] = await Promise.all([
    db
      .select({
        componentKey: appComponents.componentKey,
        repoFullName: appComponents.repoFullName,
        buildSpec: appComponents.buildSpec,
      })
      .from(projectServices)
      .innerJoin(
        appComponents,
        eq(appComponents.componentKey, projectServices.componentKey)
      )
      .where(eq(projectServices.projectId, projectId))
      .orderBy(asc(appComponents.componentKey)),
    db
      .select({
        componentKey: projectComponentBranches.componentKey,
        branch: projectComponentBranches.branch,
      })
      .from(projectComponentBranches)
      .where(eq(projectComponentBranches.projectId, projectId)),
    db
      .select({
        componentKey: deployTargets.componentKey,
        sourceBranch: deployTargets.sourceBranch,
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
      })
      .from(deployTargets)
      .innerJoin(environments, eq(environments.id, deployTargets.environmentId))
      .where(eq(environments.projectId, projectId))
      .orderBy(asc(environments.id)),
  ]);
  if (serviceRows.length === 0) return [];

  const defaultOf = new Map(
    defaults.map((row) => [row.componentKey, row.branch])
  );
  return serviceRows.map((service) => {
    const envs = targets
      .filter((t) => t.componentKey === service.componentKey)
      .map(({ id, name, slug, sourceBranch }) => ({
        id,
        name,
        slug,
        sourceBranch,
      }));
    return {
      componentKey: service.componentKey,
      repoFullName: service.repoFullName,
      defaultBranch: defaultOf.get(service.componentKey) ?? null,
      fallbackBranch: fallbackBranch(service.buildSpec),
      inUse: envs.length > 0,
      environments: envs,
    };
  });
}

/** True when a row was inserted (ON CONFLICT DO NOTHING). */
export async function insertProjectService(
  projectId: string,
  componentKey: string
): Promise<boolean> {
  const rows = await db
    .insert(projectServices)
    .values({ projectId, componentKey })
    .onConflictDoNothing()
    .returning({ componentKey: projectServices.componentKey });
  return rows.length > 0;
}

/**
 * The per-project lock between removing a project service and adding a deploy
 * target (which adds its service). Transaction-scoped advisory locks on one
 * key per project, built from the uuid's canonical text so every spelling of
 * the id takes the same lock.
 */
const projectServicesLockKey = (projectId: SQL) =>
  sql`hashtextextended(${sql`'project-services:'`} || (${projectId})::uuid::text, 0)`;

/**
 * One transaction under the project's services lock, held exclusively from
 * the in-use check to the delete: refuse when a deploy target of the project
 * uses the service, else delete its default branch and the project_services
 * row. A target's transaction shares the lock from its project-service insert
 * to its commit (recordTargetSourceIn), so whichever comes second waits: a
 * removal never misses a target written meanwhile, and a target written
 * after a removal adds its service again. A target never outlives its
 * project service.
 */
export async function deleteProjectService(
  projectId: string,
  componentKey: string
): Promise<"deleted" | "absent" | "inUse"> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${projectServicesLockKey(sql`${projectId}`)})`
    );
    if (await serviceInUse(projectId, componentKey, tx)) return "inUse";
    await tx
      .delete(projectComponentBranches)
      .where(
        and(
          eq(projectComponentBranches.projectId, projectId),
          eq(projectComponentBranches.componentKey, componentKey)
        )
      );
    const removed = await tx
      .delete(projectServices)
      .where(
        and(
          eq(projectServices.projectId, projectId),
          eq(projectServices.componentKey, componentKey)
        )
      )
      .returning({ componentKey: projectServices.componentKey });
    return removed.length > 0 ? "deleted" : "absent";
  });
}

export async function getComponentBranch(
  projectId: string,
  componentKey: string
): Promise<string | null> {
  const [row] = await db
    .select({ branch: projectComponentBranches.branch })
    .from(projectComponentBranches)
    .where(
      and(
        eq(projectComponentBranches.projectId, projectId),
        eq(projectComponentBranches.componentKey, componentKey)
      )
    );
  return row?.branch ?? null;
}

export async function upsertComponentBranch(input: {
  projectId: string;
  componentKey: string;
  branch: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(projectComponentBranches)
    .values({
      projectId: input.projectId,
      componentKey: input.componentKey,
      branch: input.branch,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [
        projectComponentBranches.projectId,
        projectComponentBranches.componentKey,
      ],
      set: {
        branch: input.branch,
        updatedBy: input.userId,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Under the project's services lock (shared; see projectServicesLockKey; the
 * caller runs it in the target's transaction), both inserts, ON CONFLICT DO
 * NOTHING, for the project of the target's environment: the target's service as a project service (a deploy target's
 * service is always one of its project's), and sourceBranch as the service's
 * default branch if it has none.
 */
export async function recordTargetSourceIn(
  executor: DbExecutor,
  target: { environmentId: string; componentKey: string; sourceBranch: string }
): Promise<void> {
  await executor
    .select({
      locked: sql`pg_advisory_xact_lock_shared(${projectServicesLockKey(sql`${environments.projectId}`)})`,
    })
    .from(environments)
    .where(eq(environments.id, target.environmentId));
  await executor
    .insert(projectServices)
    .select(
      db
        .select({
          projectId: environments.projectId,
          componentKey: sql<string>`${target.componentKey}`.as("component_key"),
          createdAt: sql<Date>`now()`.as("created_at"),
        })
        .from(environments)
        .where(eq(environments.id, target.environmentId))
    )
    .onConflictDoNothing();
  await executor
    .insert(projectComponentBranches)
    .select(
      db
        .select({
          projectId: environments.projectId,
          componentKey: sql<string>`${target.componentKey}`.as("component_key"),
          branch: sql<string>`${target.sourceBranch}`.as("branch"),
          updatedAt: sql<Date>`now()`.as("updated_at"),
          updatedBy: sql<string | null>`null::uuid`.as("updated_by"),
        })
        .from(environments)
        .where(eq(environments.id, target.environmentId))
    )
    .onConflictDoNothing();
}
