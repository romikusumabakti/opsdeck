import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  cloudflareAccounts,
  cloudflareZones,
  deployTargets,
  type EnvironmentDomain,
  environmentDomains,
  environments,
  remoteTunnels,
  servers,
} from "@/lib/db/schema";

// Database access for remote tunnels and environment domains. Permission and
// rule checks are the services' job.

export async function getEnvironmentRow(environmentId: string) {
  const [row] = await db
    .select({
      id: environments.id,
      name: environments.name,
      entryPort: environments.entryPort,
    })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row;
}

/** The distinct servers the environment's deploy targets run on. */
export async function listDeployServerIds(
  environmentId: string
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serverId: deployTargets.serverId })
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId));
  return rows.map((row) => row.serverId);
}

export async function listZones() {
  return db
    .select({ id: cloudflareZones.id, name: cloudflareZones.name })
    .from(cloudflareZones)
    .orderBy(asc(cloudflareZones.name));
}

export async function getZone(id: string) {
  const [row] = await db
    .select({ id: cloudflareZones.id, name: cloudflareZones.name })
    .from(cloudflareZones)
    .where(eq(cloudflareZones.id, id))
    .limit(1);
  return row;
}

/** The environment's domain with the names the UI shows. */
export async function getDomainView(environmentId: string) {
  const [row] = await db
    .select({
      domain: environmentDomains,
      zoneName: cloudflareZones.name,
      tunnelName: remoteTunnels.name,
    })
    .from(environmentDomains)
    .leftJoin(
      cloudflareZones,
      eq(cloudflareZones.id, environmentDomains.zoneId)
    )
    .leftJoin(
      remoteTunnels,
      eq(remoteTunnels.id, environmentDomains.remoteTunnelId)
    )
    .where(eq(environmentDomains.environmentId, environmentId))
    .limit(1);
  return row;
}

export async function getDomain(
  environmentId: string
): Promise<EnvironmentDomain | undefined> {
  const [row] = await db
    .select()
    .from(environmentDomains)
    .where(eq(environmentDomains.environmentId, environmentId))
    .limit(1);
  return row;
}

/** Whether another environment already uses the hostname. */
export async function hostnameTakenByOther(
  hostname: string,
  environmentId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: environmentDomains.environmentId })
    .from(environmentDomains)
    .where(
      and(
        eq(environmentDomains.hostname, hostname),
        ne(environmentDomains.environmentId, environmentId)
      )
    )
    .limit(1);
  return !!row;
}

export async function getRemoteTunnelByServer(serverId: string) {
  const [row] = await db
    .select()
    .from(remoteTunnels)
    .where(eq(remoteTunnels.serverId, serverId))
    .limit(1);
  return row;
}

type DomainWrite = Pick<
  typeof environmentDomains.$inferInsert,
  "kind" | "hostname" | "zoneId" | "remoteTunnelId" | "accessPolicyId"
>;

/**
 * Stores the binding, and the entry port when given, together. A changed
 * binding starts unprovisioned: the provisioning ids are cleared.
 */
export async function saveDomain(
  environmentId: string,
  write: DomainWrite,
  entryPort?: number
): Promise<void> {
  await db.transaction(async (tx) => {
    if (entryPort !== undefined) {
      await tx
        .update(environments)
        .set({ entryPort })
        .where(eq(environments.id, environmentId));
    }
    const values = { ...write, accessAppId: null, dnsRecordId: null };
    await tx
      .insert(environmentDomains)
      .values({ environmentId, ...values })
      .onConflictDoUpdate({
        target: environmentDomains.environmentId,
        set: { ...values, updatedAt: new Date() },
      });
  });
}

export async function deleteDomain(environmentId: string): Promise<void> {
  await db
    .delete(environmentDomains)
    .where(eq(environmentDomains.environmentId, environmentId));
}

// --- Remote tunnels ---

export async function listRemoteTunnels() {
  return db
    .select({
      id: remoteTunnels.id,
      serverId: remoteTunnels.serverId,
      serverName: servers.name,
      tunnelId: remoteTunnels.tunnelId,
      name: remoteTunnels.name,
      originHost: remoteTunnels.originHost,
      boundCount: sql<number>`(select count(*)::int from ${environmentDomains} where ${environmentDomains.remoteTunnelId} = ${remoteTunnels.id})`,
    })
    .from(remoteTunnels)
    .innerJoin(servers, eq(servers.id, remoteTunnels.serverId))
    .orderBy(asc(servers.name));
}

export async function getRemoteTunnel(id: string) {
  const [row] = await db
    .select()
    .from(remoteTunnels)
    .where(eq(remoteTunnels.id, id))
    .limit(1);
  return row;
}

export async function getRemoteTunnelByCloudflareId(
  accountRowId: string,
  tunnelId: string
) {
  const [row] = await db
    .select({ id: remoteTunnels.id })
    .from(remoteTunnels)
    .where(
      and(
        eq(remoteTunnels.accountId, accountRowId),
        eq(remoteTunnels.tunnelId, tunnelId)
      )
    )
    .limit(1);
  return row;
}

export async function getAccountRowId(): Promise<string | undefined> {
  const [row] = await db
    .select({ id: cloudflareAccounts.id })
    .from(cloudflareAccounts)
    .limit(1);
  return row?.id;
}

export async function serverExists(serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return !!row;
}

export async function insertRemoteTunnel(
  values: typeof remoteTunnels.$inferInsert
) {
  const [row] = await db.insert(remoteTunnels).values(values).returning();
  return row;
}

export async function countBindings(remoteTunnelId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(environmentDomains)
    .where(eq(environmentDomains.remoteTunnelId, remoteTunnelId));
  return row?.count ?? 0;
}

export async function deleteRemoteTunnel(id: string): Promise<void> {
  await db.delete(remoteTunnels).where(eq(remoteTunnels.id, id));
}
