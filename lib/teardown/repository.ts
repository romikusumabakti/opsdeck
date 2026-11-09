import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  deployTargets,
  environmentDomains,
  environmentServices,
  environments,
  type TeardownStep,
  teardownSteps,
} from "@/lib/db/schema";
import { matchDoneSteps } from "@/lib/provisioning/plan";
import type { TeardownStepSpec } from "@/lib/teardown/plan";

type DeployDir = { serverId: string; deployDir: string };

/** What planTeardown needs of an environment. */
export type TeardownEnvironment = {
  /** The environment's deploy targets, as stored (dirs not normalised). */
  targets: DeployDir[];
  /** Other environments' targets on the same servers. */
  otherTargets: DeployDir[];
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
      deployDir: deployTargets.deployDir,
    })
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(asc(deployTargets.createdAt), asc(deployTargets.id));
  const serverIds = [...new Set(targets.map((t) => t.serverId))];
  const otherTargets =
    serverIds.length === 0
      ? []
      : await db
          .select({
            serverId: deployTargets.serverId,
            deployDir: deployTargets.deployDir,
          })
          .from(deployTargets)
          .where(
            and(
              inArray(deployTargets.serverId, serverIds),
              ne(deployTargets.environmentId, environmentId)
            )
          )
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

  return { targets, otherTargets, dbServices, domain: domain ?? null };
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
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(teardownSteps)
      .where(eq(teardownSteps.environmentId, environmentId));
    const keepIds = matchDoneSteps(existing, specs);
    const kept = new Set(keepIds.filter((id): id is string => id !== null));
    const dropIds = existing.filter((s) => !kept.has(s.id)).map((s) => s.id);
    if (dropIds.length > 0) {
      await tx.delete(teardownSteps).where(inArray(teardownSteps.id, dropIds));
    }
    if (kept.size > 0) {
      // Park kept rows on negative positions first so moving one never
      // collides with another's old position on the unique index.
      await tx
        .update(teardownSteps)
        .set({ position: sql`-1 - ${teardownSteps.position}` })
        .where(inArray(teardownSteps.id, [...kept]));
    }
    for (const [position, spec] of specs.entries()) {
      const keepId = keepIds[position];
      if (keepId) {
        await tx
          .update(teardownSteps)
          .set({ position, updatedAt: new Date() })
          .where(eq(teardownSteps.id, keepId));
      } else {
        await tx.insert(teardownSteps).values({
          environmentId,
          position,
          kind: spec.kind,
          params: spec.params,
        });
      }
    }
  });
}
