import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  deployTargets,
  environmentDomains,
  environmentServices,
  environments,
  servers,
  type TeardownStep,
  teardownSteps,
} from "@/lib/db/schema";
import { replaceSteps } from "@/lib/steps/replace-steps";
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
