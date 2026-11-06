import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployTargets, environments, servers } from "@/lib/db/schema";
import type { ServerPreflight } from "@/lib/provisioning/preflight";

export type StoredPreflight = {
  preflight: ServerPreflight | null;
  preflightAt: Date | null;
};

export async function getStoredPreflight(
  serverId: string
): Promise<(StoredPreflight & { name: string }) | null> {
  const [row] = await db
    .select({
      name: servers.name,
      preflight: servers.preflight,
      preflightAt: servers.preflightAt,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return row ?? null;
}

export async function saveServerPreflight(
  serverId: string,
  preflight: ServerPreflight,
  at: Date
): Promise<void> {
  await db
    .update(servers)
    .set({ preflight, preflightAt: at })
    .where(eq(servers.id, serverId));
}

/**
 * entry_port of every environment that deploys to the server, leaving out
 * `excludeEnvironmentId` when given.
 */
export async function listEntryPortsOnServer(
  serverId: string,
  excludeEnvironmentId?: string
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ entryPort: environments.entryPort })
    .from(environments)
    .innerJoin(deployTargets, eq(deployTargets.environmentId, environments.id))
    .where(
      and(
        eq(deployTargets.serverId, serverId),
        isNotNull(environments.entryPort),
        excludeEnvironmentId
          ? ne(environments.id, excludeEnvironmentId)
          : undefined
      )
    );
  return rows.flatMap((r) => (r.entryPort === null ? [] : [r.entryPort]));
}
