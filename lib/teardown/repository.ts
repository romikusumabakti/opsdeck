import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  activityLog,
  databaseHosts,
  deployTargets,
  type EnvironmentArchive,
  type EnvironmentArchiveFile,
  environmentArchives,
  environmentDomains,
  environmentServices,
  environments,
  projects,
  type Run,
  runs,
  servers,
  type TeardownStep,
  teardownSteps,
} from "@/lib/db/schema";
import { replaceSteps } from "@/lib/steps/replace-steps";
import { normaliseHost } from "@/lib/teardown/paths";
import type { TeardownStepSpec } from "@/lib/teardown/plan";

/** What planTeardown needs of an environment. Dirs and hosts as stored. */
export type TeardownEnvironment = {
  /** The environment's deploy targets with their server's host. */
  targets: { serverId: string; host: string; deployDir: string }[];
  /** Every other environment's target with its server's host. */
  otherTargets: { host: string; deployDir: string }[];
  dbServices: {
    id: string;
    dbType: "postgres" | "mssql" | "mysql" | null;
    dbKind: "shared" | "container" | "external" | null;
  }[];
  /** Row ids (cloudflare_zones, remote_tunnels) and Cloudflare object ids. */
  domain: {
    kind: "tunnel" | "external";
    hostname: string;
    zoneId: string | null;
    remoteTunnelId: string | null;
    accessAppId: string | null;
    dnsRecordId: string | null;
  } | null;
  /** Other environments' domains that record the same Access app or DNS record. */
  otherDomains: { accessAppId: string | null; dnsRecordId: string | null }[];
};

/** The environment's targets, db services and domain, or null when absent. */
export async function loadTeardownEnvironment(
  environmentId: string
): Promise<TeardownEnvironment | null> {
  const [env] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!env) return null;

  const targets = await db
    .select({
      serverId: deployTargets.serverId,
      host: servers.host,
      deployDir: deployTargets.deployDir,
    })
    .from(deployTargets)
    .innerJoin(servers, eq(servers.id, deployTargets.serverId))
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(asc(deployTargets.createdAt), asc(deployTargets.id));
  // Every other environment's target with its host: planTeardown matches
  // machines by normalised host, since two server rows (another login, say)
  // can be one machine. The Panel has tens of targets, not thousands.
  const otherTargets =
    targets.length === 0
      ? []
      : await db
          .select({ host: servers.host, deployDir: deployTargets.deployDir })
          .from(deployTargets)
          .innerJoin(servers, eq(servers.id, deployTargets.serverId))
          .where(ne(deployTargets.environmentId, environmentId))
          .orderBy(asc(deployTargets.id));

  const dbServices = await db
    .select({
      id: environmentServices.id,
      dbType: environmentServices.dbType,
      dbKind: environmentServices.dbKind,
    })
    .from(environmentServices)
    .where(
      and(
        eq(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db")
      )
    )
    .orderBy(asc(environmentServices.id));

  const [domain] = await db
    .select({
      kind: environmentDomains.kind,
      hostname: environmentDomains.hostname,
      zoneId: environmentDomains.zoneId,
      remoteTunnelId: environmentDomains.remoteTunnelId,
      accessAppId: environmentDomains.accessAppId,
      dnsRecordId: environmentDomains.dnsRecordId,
    })
    .from(environmentDomains)
    .where(eq(environmentDomains.environmentId, environmentId));

  const ids = [domain?.accessAppId, domain?.dnsRecordId].filter(
    (id): id is string => typeof id === "string"
  );
  const otherDomains =
    ids.length === 0
      ? []
      : await db
          .select({
            accessAppId: environmentDomains.accessAppId,
            dnsRecordId: environmentDomains.dnsRecordId,
          })
          .from(environmentDomains)
          .where(
            and(
              ne(environmentDomains.environmentId, environmentId),
              or(
                inArray(environmentDomains.accessAppId, ids),
                inArray(environmentDomains.dnsRecordId, ids)
              )
            )
          )
          .orderBy(asc(environmentDomains.environmentId));

  return {
    targets,
    otherTargets,
    dbServices,
    domain: domain ?? null,
    otherDomains,
  };
}

export async function listTeardownSteps(
  environmentId: string
): Promise<TeardownStep[]> {
  return db
    .select()
    .from(teardownSteps)
    .where(eq(teardownSteps.environmentId, environmentId))
    .orderBy(asc(teardownSteps.position));
}

/**
 * Replaces the environment's teardown steps. A `done` step whose kind and
 * params equal a spec is kept (moved to the spec's position), so planning
 * again after a partial teardown never redoes finished work; every other
 * step is dropped and re-created `pending`.
 */
export async function saveTeardownSteps(
  environmentId: string,
  specs: TeardownStepSpec[]
): Promise<void> {
  await replaceSteps(teardownSteps, environmentId, specs);
}

/** What the server steps re-check at run time on one machine. */
export type StackGuard = {
  /** Other environments' deploy dirs on the machine, as stored. */
  otherDeployDirs: string[];
  /**
   * Containers a stack of this environment must never take down: every
   * registered database host's container on the machine, and every other
   * environment's docker db service there.
   */
  databaseContainers: string[];
};

/**
 * The current rows a server step checks against (another environment may
 * have been created since the plan), for the machine behind `serverId`:
 * matched by normalised host, as planTeardown does. Null when the server row
 * is gone.
 */
export async function loadStackGuard(
  environmentId: string,
  serverId: string
): Promise<StackGuard | null> {
  const all = await db
    .select({ id: servers.id, host: servers.host })
    .from(servers);
  const ours = all.find((server) => server.id === serverId);
  if (!ours) return null;
  const host = normaliseHost(ours.host);
  const machine = all
    .filter((server) => normaliseHost(server.host) === host)
    .map((server) => server.id);

  const otherTargets = await db
    .select({ deployDir: deployTargets.deployDir })
    .from(deployTargets)
    .where(
      and(
        inArray(deployTargets.serverId, machine),
        ne(deployTargets.environmentId, environmentId)
      )
    )
    .orderBy(asc(deployTargets.id));
  const hosts = await db
    .select({ containerName: databaseHosts.containerName })
    .from(databaseHosts)
    .where(inArray(databaseHosts.serverId, machine))
    .orderBy(asc(databaseHosts.id));
  const otherDbServices = await db
    .select({ serviceName: environmentServices.serviceName })
    .from(environmentServices)
    .where(
      and(
        inArray(environmentServices.serverId, machine),
        ne(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db"),
        eq(environmentServices.serviceType, "docker")
      )
    )
    .orderBy(asc(environmentServices.id));
  return {
    otherDeployDirs: otherTargets.map((t) => t.deployDir),
    databaseContainers: [
      ...new Set([
        ...hosts.map((h) => h.containerName),
        ...otherDbServices.map((s) => s.serviceName),
      ]),
    ],
  };
}

/**
 * The db binding an archive_database or drop_database step names, or null
 * when it is gone.
 */
export async function loadTeardownDbService(serviceId: string) {
  const [row] = await db
    .select({
      environmentId: environmentServices.environmentId,
      role: environmentServices.role,
      dbType: environmentServices.dbType,
      dbKind: environmentServices.dbKind,
      dbName: environmentServices.dbName,
      dbRole: environmentServices.dbRole,
      databaseHostId: environmentServices.databaseHostId,
      serverId: environmentServices.serverId,
      serviceType: environmentServices.serviceType,
      serviceName: environmentServices.serviceName,
    })
    .from(environmentServices)
    .where(eq(environmentServices.id, serviceId));
  return row ?? null;
}

// --- The runner's rows ---

export async function getTeardownRun(runId: string): Promise<{
  environmentId: string;
  userId: string | null;
  status: Run["status"];
} | null> {
  const [row] = await db
    .select({
      environmentId: runs.environmentId,
      userId: runs.userId,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  return row ?? null;
}

/** `error` is the stable code of a failure (TEARDOWN_ERRORS). */
export async function markTeardownStep(
  id: string,
  status: TeardownStep["status"],
  { error, runId }: { error?: string; runId: string }
): Promise<void> {
  await db
    .update(teardownSteps)
    .set({
      status,
      lastError: status === "failed" ? (error ?? null) : null,
      lastRunId: runId,
      completedAt: status === "done" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(teardownSteps.id, id));
}

/** Marks the environment's `running` steps failed with `code`. */
export async function failRunningTeardownSteps(
  environmentId: string,
  code: string
): Promise<void> {
  await db
    .update(teardownSteps)
    .set({ status: "failed", lastError: code, updatedAt: new Date() })
    .where(
      and(
        eq(teardownSteps.environmentId, environmentId),
        eq(teardownSteps.status, "running")
      )
    );
}

// --- Archives ---

/** The names an archive row keeps of a deleted environment. */
export async function loadArchiveSnapshot(environmentId: string): Promise<{
  projectName: string;
  environmentName: string;
  environmentSlug: string;
} | null> {
  const [row] = await db
    .select({
      projectName: projects.name,
      environmentName: environments.name,
      environmentSlug: environments.slug,
    })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(environments.id, environmentId));
  return row ?? null;
}

/**
 * The environment's archive still being written: one per teardown, found by
 * the environment and an unset completed_at, so a retry adds to it.
 */
export async function findOpenArchive(
  environmentId: string
): Promise<EnvironmentArchive | null> {
  const [row] = await db
    .select()
    .from(environmentArchives)
    .where(
      and(
        eq(environmentArchives.environmentId, environmentId),
        isNull(environmentArchives.completedAt)
      )
    )
    .orderBy(asc(environmentArchives.createdAt), asc(environmentArchives.id))
    .limit(1);
  return row ?? null;
}

/**
 * Inserts the environment's open archive, or returns the one already open:
 * the partial unique index allows one per environment, so two first archive
 * steps at once (a redelivered job still alive) share a row.
 */
export async function createArchive(
  values: typeof environmentArchives.$inferInsert
): Promise<EnvironmentArchive> {
  const [created] = await db
    .insert(environmentArchives)
    .values(values)
    .onConflictDoNothing({
      target: environmentArchives.environmentId,
      where: sql`${environmentArchives.completedAt} IS NULL`,
    })
    .returning();
  if (created) return created;
  const open = values.environmentId
    ? await findOpenArchive(values.environmentId)
    : null;
  if (!open) throw new Error("The open environment archive vanished");
  return open;
}

/** Appends a file to the archive's list, unless one of that name is listed. */
export async function addArchiveFile(
  archiveId: string,
  file: EnvironmentArchiveFile
): Promise<void> {
  const entry = JSON.stringify([file]);
  const named = JSON.stringify([{ name: file.name }]);
  await db
    .update(environmentArchives)
    .set({
      files: sql`case when ${environmentArchives.files} @> ${named}::jsonb then ${environmentArchives.files} else ${environmentArchives.files} || ${entry}::jsonb end`,
    })
    .where(eq(environmentArchives.id, archiveId));
}

/**
 * delete_environment: in one transaction, closes the environment's open
 * archive (completed_at), deletes the environment row (the cascade removes
 * its steps and runs) and records `environment.deleted` {environment,
 * archiveId}, so a crash can lose none of them. The archive id is the one
 * just closed, else the newest one already closed. Null when the environment
 * is gone already.
 */
export async function deleteTeardownEnvironment(
  environmentId: string,
  actorId: string | null
): Promise<{ environmentName: string; archiveId: string | null } | null> {
  return db.transaction(async (tx) => {
    const [closed] = await tx
      .update(environmentArchives)
      .set({ completedAt: new Date() })
      .where(
        and(
          eq(environmentArchives.environmentId, environmentId),
          isNull(environmentArchives.completedAt)
        )
      )
      .returning({ id: environmentArchives.id });
    const [latest] = closed
      ? [closed]
      : await tx
          .select({ id: environmentArchives.id })
          .from(environmentArchives)
          .where(eq(environmentArchives.environmentId, environmentId))
          .orderBy(
            desc(environmentArchives.createdAt),
            desc(environmentArchives.id)
          )
          .limit(1);
    const [deleted] = await tx
      .delete(environments)
      .where(eq(environments.id, environmentId))
      .returning({ name: environments.name });
    if (!deleted) return null;
    const archiveId = latest?.id ?? null;
    await tx.insert(activityLog).values({
      actorId,
      action: "environment.deleted",
      entityType: "environment",
      entityId: environmentId,
      data: {
        environment: deleted.name,
        ...(archiveId ? { archiveId } : {}),
      },
    });
    return { environmentName: deleted.name, archiveId };
  });
}

export async function environmentExists(
  environmentId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return row !== undefined;
}
