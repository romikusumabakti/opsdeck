import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import {
  appComponents,
  apps,
  deployTargets,
  environments,
  projectApps,
  projectComponentBranches,
} from "@/lib/db/schema";
import { fallbackBranch } from "@/lib/setup/source-branch";

export type ProjectSourceEnvironment = {
  id: string;
  name: string;
  slug: string;
  sourceBranch: string | null;
};

export type ProjectSourceComponent = {
  componentKey: string;
  repoFullName: string;
  defaultBranch: string | null;
  fallbackBranch: string;
  environments: ProjectSourceEnvironment[];
};

export type ProjectSource = {
  appId: string;
  appKey: string;
  name: string;
  inUse: boolean;
  components: ProjectSourceComponent[];
};

/** Environments of the project, and its targets with the app of each target's component. */
async function usage(projectId: string, executor: DbExecutor) {
  const envs = await executor
    .select({
      id: environments.id,
      name: environments.name,
      slug: environments.slug,
      appId: environments.appId,
    })
    .from(environments)
    .where(eq(environments.projectId, projectId))
    .orderBy(asc(environments.id));
  const targets = await executor
    .select({
      environmentId: deployTargets.environmentId,
      componentKey: deployTargets.componentKey,
      appId: appComponents.appId,
      sourceBranch: deployTargets.sourceBranch,
    })
    .from(deployTargets)
    .innerJoin(environments, eq(environments.id, deployTargets.environmentId))
    .innerJoin(
      appComponents,
      eq(appComponents.componentKey, deployTargets.componentKey)
    )
    .where(eq(environments.projectId, projectId));
  return { envs, targets };
}

/** project_apps ∪ environments.app_id ∪ apps of components targeted by the project's environments. */
export async function projectSourceAppIds(
  projectId: string
): Promise<string[]> {
  const rows = await db
    .select({ appId: projectApps.appId })
    .from(projectApps)
    .where(eq(projectApps.projectId, projectId));
  const { envs, targets } = await usage(projectId, db);
  const ids = new Set(rows.map((row) => row.appId));
  for (const env of envs) if (env.appId) ids.add(env.appId);
  for (const target of targets) ids.add(target.appId);
  return [...ids];
}

/** Some environment of the project has this app, or a target on one of its components. */
export async function appInUse(
  projectId: string,
  appId: string,
  executor: DbExecutor = db
): Promise<boolean> {
  const [env] = await executor
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(eq(environments.projectId, projectId), eq(environments.appId, appId))
    )
    .limit(1);
  if (env) return true;
  const [target] = await executor
    .select({ environmentId: deployTargets.environmentId })
    .from(deployTargets)
    .innerJoin(environments, eq(environments.id, deployTargets.environmentId))
    .innerJoin(
      appComponents,
      eq(appComponents.componentKey, deployTargets.componentKey)
    )
    .where(
      and(eq(environments.projectId, projectId), eq(appComponents.appId, appId))
    )
    .limit(1);
  return Boolean(target);
}

export async function loadProjectSources(
  projectId: string
): Promise<ProjectSource[]> {
  const appIds = await projectSourceAppIds(projectId);
  if (appIds.length === 0) return [];

  const [appRows, componentRows, defaults, { envs, targets }] =
    await Promise.all([
      db
        .select({ id: apps.id, appKey: apps.appKey, name: apps.name })
        .from(apps)
        .where(inArray(apps.id, appIds))
        .orderBy(asc(apps.appKey)),
      db
        .select({
          componentKey: appComponents.componentKey,
          appId: appComponents.appId,
          repoFullName: appComponents.repoFullName,
          buildSpec: appComponents.buildSpec,
        })
        .from(appComponents)
        .where(inArray(appComponents.appId, appIds))
        .orderBy(asc(appComponents.componentKey)),
      db
        .select({
          componentKey: projectComponentBranches.componentKey,
          branch: projectComponentBranches.branch,
        })
        .from(projectComponentBranches)
        .where(eq(projectComponentBranches.projectId, projectId)),
      usage(projectId, db),
    ]);

  const defaultOf = new Map(
    defaults.map((row) => [row.componentKey, row.branch])
  );
  const branchOf = new Map(
    targets.map((t) => [`${t.environmentId}:${t.componentKey}`, t.sourceBranch])
  );

  return appRows.map((app) => {
    const appEnvs = envs.filter(
      (env) =>
        env.appId === app.id ||
        targets.some((t) => t.environmentId === env.id && t.appId === app.id)
    );
    return {
      appId: app.id,
      appKey: app.appKey,
      name: app.name,
      inUse: appEnvs.length > 0,
      components: componentRows
        .filter((component) => component.appId === app.id)
        .map((component) => ({
          componentKey: component.componentKey,
          repoFullName: component.repoFullName,
          defaultBranch: defaultOf.get(component.componentKey) ?? null,
          fallbackBranch: fallbackBranch(component.buildSpec),
          environments: appEnvs.map((env) => ({
            id: env.id,
            name: env.name,
            slug: env.slug,
            sourceBranch:
              branchOf.get(`${env.id}:${component.componentKey}`) ?? null,
          })),
        })),
    };
  });
}

/** True when a row was inserted (ON CONFLICT DO NOTHING). */
export async function insertProjectApp(
  projectId: string,
  appId: string
): Promise<boolean> {
  const rows = await db
    .insert(projectApps)
    .values({ projectId, appId })
    .onConflictDoNothing()
    .returning({ appId: projectApps.appId });
  return rows.length > 0;
}

/** One transaction: refuse when in use, else delete the app's branch rows and the project_apps row. */
export async function deleteProjectApp(
  projectId: string,
  appId: string
): Promise<"deleted" | "absent" | "inUse"> {
  return await db.transaction(async (tx) => {
    if (await appInUse(projectId, appId, tx)) return "inUse";
    await tx
      .delete(projectComponentBranches)
      .where(
        and(
          eq(projectComponentBranches.projectId, projectId),
          inArray(
            projectComponentBranches.componentKey,
            tx
              .select({ key: appComponents.componentKey })
              .from(appComponents)
              .where(eq(appComponents.appId, appId))
          )
        )
      );
    const removed = await tx
      .delete(projectApps)
      .where(
        and(eq(projectApps.projectId, projectId), eq(projectApps.appId, appId))
      )
      .returning({ appId: projectApps.appId });
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

/** INSERT … SELECT project_id FROM environments WHERE id = environmentId … ON CONFLICT DO NOTHING. */
export async function ensureProjectSourceIn(
  executor: DbExecutor,
  environmentId: string,
  appId: string
): Promise<void> {
  await executor
    .insert(projectApps)
    .select(
      db
        .select({
          projectId: environments.projectId,
          appId: sql<string>`${appId}::uuid`.as("app_id"),
          createdAt: sql<Date>`now()`.as("created_at"),
        })
        .from(environments)
        .where(eq(environments.id, environmentId))
    )
    .onConflictDoNothing();
}

/** Both inserts, ON CONFLICT DO NOTHING: the component's app as a source, and sourceBranch as the default if none. */
export async function recordTargetSourceIn(
  executor: DbExecutor,
  target: { environmentId: string; componentKey: string; sourceBranch: string }
): Promise<void> {
  await executor
    .insert(projectApps)
    .select(
      db
        .select({
          projectId: environments.projectId,
          appId: appComponents.appId,
          createdAt: sql<Date>`now()`.as("created_at"),
        })
        .from(environments)
        .innerJoin(
          appComponents,
          eq(appComponents.componentKey, target.componentKey)
        )
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
