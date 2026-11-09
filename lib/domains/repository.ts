import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { type DbTransaction, db } from "@/lib/db";
import {
  cloudflareAccounts,
  cloudflareZones,
  deployTargets,
  type EnvironmentDomain,
  environmentDomains,
  environments,
  provisioningSteps,
  remoteTunnels,
  servers,
} from "@/lib/db/schema";
import { domainUrl } from "@/lib/domains/validation";
import { holdEnvironmentShared, teardownBlocks } from "@/lib/teardown/guard";

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

/** Cloudflare's id of a registered zone (the row's `zoneId`). */
export async function getZoneCloudflareId(
  id: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ zoneId: cloudflareZones.zoneId })
    .from(cloudflareZones)
    .where(eq(cloudflareZones.id, id))
    .limit(1);
  return row?.zoneId;
}

/** Records the Access app the provisioning step created or reused. */
export async function setDomainAccessAppId(
  environmentId: string,
  accessAppId: string
): Promise<void> {
  await db
    .update(environmentDomains)
    .set({ accessAppId, updatedAt: new Date() })
    .where(eq(environmentDomains.environmentId, environmentId));
}

/** Records the DNS record the provisioning step created or reused. */
export async function setDomainDnsRecordId(
  environmentId: string,
  dnsRecordId: string
): Promise<void> {
  await db
    .update(environmentDomains)
    .set({ dnsRecordId, updatedAt: new Date() })
    .where(eq(environmentDomains.environmentId, environmentId));
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

/**
 * Whether another environment already uses the hostname (any environment,
 * without `environmentId`).
 */
export async function hostnameTakenByOther(
  hostname: string,
  environmentId?: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: environmentDomains.environmentId })
    .from(environmentDomains)
    .where(
      and(
        eq(environmentDomains.hostname, hostname),
        environmentId
          ? ne(environmentDomains.environmentId, environmentId)
          : undefined
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

// A provisioning step of these kinds that is done or running has (or is about
// to have) changed Cloudflare, whether or not an id was written yet.
const stepStarted = (environmentId: SQL | string) =>
  sql`exists (select 1 from ${provisioningSteps} where ${provisioningSteps.environmentId} = ${environmentId} and ${provisioningSteps.kind} in ('tunnel_route', 'access_app', 'dns_record') and ${provisioningSteps.status} in ('done', 'running'))`;

/** Whether a Cloudflare provisioning step of the environment has started. */
export async function hasProvisioningProgress(
  environmentId: string
): Promise<boolean> {
  const rows = await db.execute<{ started: boolean }>(
    sql`select ${stepStarted(environmentId)} as started`
  );
  return rows[0]?.started === true;
}

// Still unprovisioned, judged by the row itself so the check and the write are
// one statement.
const unprovisioned = sql`${environmentDomains.accessAppId} is null and ${environmentDomains.dnsRecordId} is null and not ${stepStarted(sql`${environmentDomains.environmentId}`)}`;

type DomainWrite = Pick<
  typeof environmentDomains.$inferInsert,
  "kind" | "hostname" | "zoneId" | "remoteTunnelId" | "accessPolicyId"
>;

/**
 * What a domain write did: `provisioned` (the existing binding forbids it) and
 * `tearingDown` (a teardown is under way, lib/teardown/guard) wrote nothing.
 */
export type DomainSaveResult = "saved" | "provisioned" | "tearingDown";

/**
 * Stores the binding, the environment's URL derived from it and the entry
 * port when given, together. A changed binding starts unprovisioned: the
 * provisioning ids are cleared. Writes nothing when the existing binding is
 * provisioned or a teardown is under way: a binding its plan does not hold
 * would outlive the environment in Cloudflare. Removing a binding keeps the
 * URL.
 */
export async function saveDomain(
  environmentId: string,
  write: DomainWrite,
  entryPort?: number
): Promise<DomainSaveResult> {
  return db.transaction(async (tx) => {
    await holdEnvironmentShared(tx, environmentId);
    if (await teardownBlocks(environmentId, tx)) return "tearingDown";
    return (await saveDomainIn(tx, environmentId, write, entryPort))
      ? "saved"
      : "provisioned";
  });
}

/** saveDomain inside the caller's transaction. */
export async function saveDomainIn(
  tx: DbTransaction,
  environmentId: string,
  write: DomainWrite,
  entryPort?: number
): Promise<boolean> {
  const values = { ...write, accessAppId: null, dnsRecordId: null };
  const rows = await tx
    .insert(environmentDomains)
    .values({ environmentId, ...values })
    .onConflictDoUpdate({
      target: environmentDomains.environmentId,
      set: { ...values, updatedAt: new Date() },
      setWhere: unprovisioned,
    })
    .returning({ id: environmentDomains.environmentId });
  if (rows.length === 0) return false;
  await tx
    .update(environments)
    .set({
      url: domainUrl(write.hostname),
      ...(entryPort !== undefined ? { entryPort } : {}),
    })
    .where(eq(environments.id, environmentId));
  return true;
}

/**
 * Records a tunnel binding whose Cloudflare objects already exist, with their
 * ids, and the environment's URL. Only for an environment without a binding
 * (else `provisioned`) and not while a teardown is under way (`tearingDown`);
 * neither writes anything. A hostname another environment holds fails with
 * the unique violation (23505).
 */
export async function adoptDomain(
  environmentId: string,
  row: DomainWrite &
    Pick<typeof environmentDomains.$inferInsert, "accessAppId" | "dnsRecordId">
): Promise<DomainSaveResult> {
  return db.transaction(async (tx) => {
    await holdEnvironmentShared(tx, environmentId);
    if (await teardownBlocks(environmentId, tx)) return "tearingDown";
    const rows = await tx
      .insert(environmentDomains)
      .values({ environmentId, ...row })
      .onConflictDoNothing({ target: environmentDomains.environmentId })
      .returning({ id: environmentDomains.environmentId });
    if (rows.length === 0) return "provisioned";
    await tx
      .update(environments)
      .set({ url: domainUrl(row.hostname) })
      .where(eq(environments.id, environmentId));
    return "saved";
  });
}

/** Removes an unprovisioned binding. False when none was removed. */
export async function deleteDomain(environmentId: string): Promise<boolean> {
  const rows = await db
    .delete(environmentDomains)
    .where(
      and(eq(environmentDomains.environmentId, environmentId), unprovisioned)
    )
    .returning({ id: environmentDomains.environmentId });
  return rows.length > 0;
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
