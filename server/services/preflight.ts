import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission } from "@/lib/authz";
import { loadServerCredentials } from "@/lib/environments";
import { pickFreePort } from "@/lib/provisioning/ports";
import {
  buildPreflightCommand,
  parsePreflight,
  type ServerPreflight,
} from "@/lib/provisioning/preflight";
import { executeRemoteCommand } from "@/lib/ssh";
import { getServerTranslator } from "@/server/i18n";
import {
  getStoredPreflight,
  listEntryPortsOnServer,
  saveServerPreflight,
} from "@/server/services/preflight-repository";

const PREFLIGHT_TIMEOUT_MS = 30_000;

async function requireServer(serverId: string) {
  const stored = await getStoredPreflight(serverId);
  if (!stored) throw new HTTPException(404, { message: "Not Found" });
  return stored;
}

/** Scans the server over SSH and stores the facts. Org `server:manage`. */
export async function runServerPreflight(
  serverId: string
): Promise<ServerPreflight> {
  const session = await requireOrgPermission({ server: ["manage"] });
  const server = await requireServer(serverId);
  const creds = await loadServerCredentials(serverId);
  if (!creds) throw new HTTPException(404, { message: "Not Found" });

  const registry = process.env.DEPLOY_REGISTRY || null;
  let output: string;
  try {
    output = await executeRemoteCommand(
      creds,
      buildPreflightCommand(registry),
      PREFLIGHT_TIMEOUT_MS
    );
  } catch (error) {
    console.error(`Preflight failed for server ${serverId}:`, error);
    const t = await getServerTranslator("actionErrors");
    throw new HTTPException(502, { message: t("preflightFailed") });
  }

  const preflight = parsePreflight(output, registry);
  await saveServerPreflight(serverId, preflight, new Date());
  // Only the server name: the scan output stays out of the activity log.
  await recordActivity({
    actorId: session.user.id,
    action: "server.preflight",
    entityType: "server",
    entityId: serverId,
    data: { server: server.name },
  });
  return preflight;
}

export async function getServerPreflight(serverId: string) {
  await requireOrgPermission({ server: ["manage"] });
  const { preflight, preflightAt } = await requireServer(serverId);
  return { preflight, preflightAt };
}

/**
 * Lowest free entry port on the server: not listening, not published, and not
 * already chosen by another environment that deploys there (so two pending
 * environments never get the same suggestion).
 */
export async function suggestEntryPort(
  serverId: string
): Promise<{ port: number | null; preflightAt: Date | null }> {
  await requireOrgPermission({ server: ["manage"] });
  const { preflight, preflightAt } = await requireServer(serverId);
  return { port: await freePortOn(serverId, preflight), preflightAt };
}

async function freePortOn(
  serverId: string,
  preflight: ServerPreflight | null
): Promise<number | null> {
  const taken = [
    ...(preflight?.listeningPorts ?? []),
    ...(preflight?.publishedPorts ?? []),
    ...(await listEntryPortsOnServer(serverId)),
  ];
  return pickFreePort(taken);
}

/**
 * suggestEntryPort's port for a caller that has checked its own permission
 * (the setup preview), or null while the server has no stored scan: without
 * one the port must be entered.
 */
export async function freeEntryPort(serverId: string): Promise<number | null> {
  const stored = await getStoredPreflight(serverId);
  if (!stored?.preflight) return null;
  return freePortOn(serverId, stored.preflight);
}
