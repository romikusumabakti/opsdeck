import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireOrgPermission } from "@/lib/authz";
import { listTunnels } from "@/lib/cloudflare/api";
import { DOMAIN_ERRORS } from "@/lib/domains/errors";
import {
  countBindings,
  deleteRemoteTunnel as deleteRow,
  getAccountRowId,
  getRemoteTunnel,
  getRemoteTunnelByCloudflareId,
  getRemoteTunnelByServer,
  insertRemoteTunnel,
  listRemoteTunnels as listRows,
  serverExists,
} from "@/lib/domains/repository";
import { originHostSchema } from "@/lib/domains/validation";
import { uuidSchema } from "@/lib/validation";
import { notFound } from "@/server/errors";
import { callCloudflare } from "@/server/services/cloudflare-account";

/**
 * Remotely-managed Cloudflare tunnels registered per server (one each). The
 * Panel later edits a registered tunnel's ingress through the API, so a tunnel
 * with a locally managed config is refused. Org `server:manage` throughout.
 */

const SERVER_MANAGE = { server: ["manage"] } as const;

const fail = (status: 409 | 422, message: string): never => {
  throw new HTTPException(status, { message });
};

export const remoteTunnelInputSchema = z
  .object({
    serverId: uuidSchema,
    tunnelId: z.string().trim().min(1).max(100),
    originHost: originHostSchema.default("localhost"),
  })
  .strict();

export async function listRemoteTunnels() {
  await requireOrgPermission(SERVER_MANAGE);
  return listRows();
}

export async function registerRemoteTunnel(
  input: z.infer<typeof remoteTunnelInputSchema>
) {
  await requireOrgPermission(SERVER_MANAGE);
  if (!(await serverExists(input.serverId))) {
    return fail(422, DOMAIN_ERRORS.serverUnknown);
  }
  if (await getRemoteTunnelByServer(input.serverId)) {
    return fail(409, DOMAIN_ERRORS.tunnelServerTaken);
  }

  // The name comes from Cloudflare, never from the client; an id the account
  // does not list is refused.
  const accountRowId = await getAccountRowId();
  if (!accountRowId) return fail(409, DOMAIN_ERRORS.cloudflareNotConfigured);
  const tunnels = await callCloudflare(listTunnels);
  const tunnel = tunnels.find((t) => t.id === input.tunnelId);
  if (!tunnel) return fail(422, DOMAIN_ERRORS.tunnelUnknown);
  // A locally managed tunnel's config would be replaced by the Panel's PUT.
  if (!tunnel.remoteConfig) return fail(422, DOMAIN_ERRORS.tunnelNotRemote);
  if (await getRemoteTunnelByCloudflareId(accountRowId, tunnel.id)) {
    return fail(409, DOMAIN_ERRORS.tunnelAlreadyRegistered);
  }

  return insertRemoteTunnel({
    accountId: accountRowId,
    serverId: input.serverId,
    tunnelId: tunnel.id,
    name: tunnel.name,
    originHost: input.originHost,
  });
}

export async function deleteRemoteTunnel(id: string) {
  await requireOrgPermission(SERVER_MANAGE);
  if (!(await getRemoteTunnel(id))) notFound();
  if ((await countBindings(id)) > 0)
    return fail(409, DOMAIN_ERRORS.tunnelBound);
  await deleteRow(id);
}
