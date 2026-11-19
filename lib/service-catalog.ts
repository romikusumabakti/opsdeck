import { and, asc, count, countDistinct, desc, eq, inArray } from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import {
  appComponents,
  apps,
  builds,
  ciConnections,
  deployTargets,
  environments,
  projectServices,
  projects,
} from "@/lib/db/schema";

// The services model (Stage 8): a Service is one app_components row, keyed by
// its component key (the key every deploy target, build, registry image and
// build webhook already uses). The table keeps its old name until the
// contract release; code reads services through this layer. (Not to be
// confused with lib/services.ts: the compose/systemd services on a server.)

/** A service as code outside the CI/notify path sees it: no notify secret. */
export type Service = {
  key: string;
  repoFullName: string;
  ciConnectionId: string;
  ciRepoId: string | null;
  bundleImage: string;
  notifySecretName: string;
  pipelineMode: (typeof appComponents.$inferSelect)["pipelineMode"];
  buildSpec: (typeof appComponents.$inferSelect)["buildSpec"];
  pipelineFileCommits: (typeof appComponents.$inferSelect)["pipelineFileCommits"];
  createdAt: Date;
};

const serviceColumns = {
  key: appComponents.componentKey,
  repoFullName: appComponents.repoFullName,
  ciConnectionId: appComponents.ciConnectionId,
  ciRepoId: appComponents.ciRepoId,
  bundleImage: appComponents.bundleImage,
  notifySecretName: appComponents.notifySecretName,
  pipelineMode: appComponents.pipelineMode,
  buildSpec: appComponents.buildSpec,
  pipelineFileCommits: appComponents.pipelineFileCommits,
  createdAt: appComponents.createdAt,
};

export async function getService(
  key: string,
  executor: DbExecutor = db
): Promise<Service | null> {
  const [row] = await executor
    .select(serviceColumns)
    .from(appComponents)
    .where(eq(appComponents.componentKey, key))
    .limit(1);
  return row ?? null;
}

/** Every registered service, by key. */
export async function listServices(
  executor: DbExecutor = db
): Promise<Service[]> {
  return executor
    .select(serviceColumns)
    .from(appComponents)
    .orderBy(asc(appComponents.componentKey));
}

/** The project's services (its Sources), by key. */
export async function listProjectServices(
  projectId: string,
  executor: DbExecutor = db
): Promise<Service[]> {
  return executor
    .select(serviceColumns)
    .from(projectServices)
    .innerJoin(
      appComponents,
      eq(appComponents.componentKey, projectServices.componentKey)
    )
    .where(eq(projectServices.projectId, projectId))
    .orderBy(asc(appComponents.componentKey));
}

export async function isProjectService(
  projectId: string,
  key: string,
  executor: DbExecutor = db
): Promise<boolean> {
  const rows = await executor
    .select({ key: projectServices.componentKey })
    .from(projectServices)
    .where(
      and(
        eq(projectServices.projectId, projectId),
        eq(projectServices.componentKey, key)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** A service row to register: no legacy app, no creation time. */
export type NewService = Omit<
  typeof appComponents.$inferInsert,
  "appId" | "createdAt"
>;

/**
 * Registers services without an app (`app_id` null), in one statement. A
 * taken key surfaces as a unique violation.
 */
export async function insertServices(
  rows: NewService[],
  executor: DbExecutor = db
): Promise<void> {
  if (rows.length === 0) return;
  await executor
    .insert(appComponents)
    .values(rows.map((row) => ({ ...row, appId: null })));
}

/** A service's newest build (any branch), for the admin's Services list. */
export type ServiceLastBuild = {
  branch: string;
  tag: string;
  receivedAt: Date;
};

/** A service as Admin › Services lists it: where it is used, its last build. */
export type ServiceOverview = Service & {
  ciConnectionName: string | null;
  /** Projects that have the service as a source (project_services). */
  projectCount: number;
  /** Environments with a deploy target of the service. */
  environmentCount: number;
  lastBuild: ServiceLastBuild | null;
};

/** Every service's newest build, by key (one row per service that has one). */
async function lastBuilds(
  keys: readonly string[] | null
): Promise<Map<string, ServiceLastBuild>> {
  const rows = await db
    .selectDistinctOn([builds.componentKey], {
      key: builds.componentKey,
      branch: builds.branch,
      tag: builds.tag,
      receivedAt: builds.receivedAt,
    })
    .from(builds)
    .where(keys === null ? undefined : inArray(builds.componentKey, keys))
    .orderBy(builds.componentKey, desc(builds.receivedAt), desc(builds.id));
  return new Map(rows.map(({ key, ...build }) => [key, build]));
}

/** Every registered service with its usage and last build, by key. */
export async function listServiceOverview(): Promise<ServiceOverview[]> {
  const [rows, projectCounts, environmentCounts, latest] = await Promise.all([
    db
      .select({ ...serviceColumns, ciConnectionName: ciConnections.name })
      .from(appComponents)
      .leftJoin(
        ciConnections,
        eq(ciConnections.id, appComponents.ciConnectionId)
      )
      .orderBy(asc(appComponents.componentKey)),
    db
      .select({ key: projectServices.componentKey, n: count() })
      .from(projectServices)
      .groupBy(projectServices.componentKey),
    db
      .select({
        key: deployTargets.componentKey,
        n: countDistinct(deployTargets.environmentId),
      })
      .from(deployTargets)
      .groupBy(deployTargets.componentKey),
    lastBuilds(null),
  ]);
  const projectsOf = new Map(projectCounts.map((r) => [r.key, r.n]));
  const environmentsOf = new Map(environmentCounts.map((r) => [r.key, r.n]));
  return rows.map((row) => ({
    ...row,
    projectCount: projectsOf.get(row.key) ?? 0,
    environmentCount: environmentsOf.get(row.key) ?? 0,
    lastBuild: latest.get(row.key) ?? null,
  }));
}

/** A service's page: the projects and environments that use it. */
export type ServiceDetail = Omit<
  ServiceOverview,
  "projectCount" | "environmentCount"
> & {
  projects: { id: string; key: string; name: string }[];
  environments: {
    id: string;
    name: string;
    slug: string;
    projectKey: string;
  }[];
};

export async function getServiceDetail(
  key: string
): Promise<ServiceDetail | null> {
  const [row] = await db
    .select({ ...serviceColumns, ciConnectionName: ciConnections.name })
    .from(appComponents)
    .leftJoin(ciConnections, eq(ciConnections.id, appComponents.ciConnectionId))
    .where(eq(appComponents.componentKey, key))
    .limit(1);
  if (!row) return null;
  const [projectRows, environmentRows, build] = await Promise.all([
    db
      .select({ id: projects.id, key: projects.key, name: projects.name })
      .from(projectServices)
      .innerJoin(projects, eq(projects.id, projectServices.projectId))
      .where(eq(projectServices.componentKey, key))
      .orderBy(asc(projects.key)),
    db
      .selectDistinct({
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
        projectKey: projects.key,
      })
      .from(deployTargets)
      .innerJoin(environments, eq(environments.id, deployTargets.environmentId))
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(deployTargets.componentKey, key))
      .orderBy(asc(projects.key), asc(environments.name)),
    lastBuilds([key]),
  ]);
  return {
    ...row,
    lastBuild: build.get(key) ?? null,
    projects: projectRows,
    environments: environmentRows,
  };
}

/**
 * LEGACY (Stage 8): where an old `/admin/repositories/<appKey>` or
 * `/apps/<appKey>` URL leads. The retired app's services (by `app_id`),
 * else the service whose key is `key` itself, else none. Read-only and only
 * for those redirects; nothing else reads `apps`.
 */
export async function legacyAppServices(
  key: string
): Promise<{ key: string; repoFullName: string }[]> {
  const fromApp = await db
    .select({
      key: appComponents.componentKey,
      repoFullName: appComponents.repoFullName,
    })
    .from(appComponents)
    .innerJoin(apps, eq(apps.id, appComponents.appId))
    .where(eq(apps.appKey, key))
    .orderBy(asc(appComponents.componentKey));
  if (fromApp.length > 0) return fromApp;
  const service = await getService(key);
  return service
    ? [{ key: service.key, repoFullName: service.repoFullName }]
    : [];
}
