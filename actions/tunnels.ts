"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { recordActivity } from "@/lib/activity";
import { requireAdmin } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  type CloudflareZone,
  cloudflareZones,
  type NewCloudflareZone,
  type NewTunnel,
  type SafeCloudflareZone,
  servers,
  type Tunnel,
  type TunnelWithContext,
  tunnels,
} from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  checkDnsRecord,
  cnameTarget,
  createCnameRecord,
  type DnsCheck,
  deleteDnsRecord,
  findDnsRecord,
  verifyZoneAccess,
} from "@/lib/tunnels/cloudflare";
import { addExternalNetwork } from "@/lib/tunnels/compose";
import {
  addRoute,
  formatOrigin,
  type IngressRoute,
  parseIngress,
  removeRoute,
} from "@/lib/tunnels/ingress";
import {
  applyStack,
  assertConfigApplied,
  commitStagedFile,
  composeFilePath,
  configFilePath,
  containerNetworks,
  containerState,
  discardStagedFile,
  listContainers,
  probeTunnelHealth,
  readRemoteText,
  restoreBackup,
  type SshCreds,
  stageRemoteText,
  tunnelImage,
  validateCompose,
  validateIngressFile,
  waitForTunnelHealth,
  writeRemoteTextAtomically,
} from "@/lib/tunnels/remote";
import type { ActionResponse } from "@/lib/types";
import {
  cloudflareZoneInputSchema,
  cloudflareZoneUpdateSchema,
  tunnelHostnameSchema,
  tunnelInputSchema,
  tunnelRouteInputSchema,
  tunnelUpdateSchema,
} from "@/lib/validation";

// Admin-managed Cloudflare Tunnel subdomains. Everything here is admin-only:
// publishing or withdrawing a hostname changes what the public internet can
// reach, which is a wider blast radius than any other action in this panel.
//
// The division of labour: lib/tunnels/ingress and lib/tunnels/compose edit YAML
// (pure, unit-tested), lib/tunnels/remote moves bytes and runs commands, and
// lib/tunnels/cloudflare talks DNS. This file is the ordering and the recovery.

const ADMIN_TUNNELS_PATH = "/admin/tunnels";

// =========================
// Zones
// =========================

function toSafeZone(row: CloudflareZone): SafeCloudflareZone {
  const { apiToken, ...rest } = row;
  return { ...rest, hasToken: apiToken.length > 0 };
}

export async function getCloudflareZones(): Promise<SafeCloudflareZone[]> {
  await requireAdmin();
  const rows = await db
    .select()
    .from(cloudflareZones)
    .orderBy(cloudflareZones.name);
  return rows.map(toSafeZone);
}

export async function createCloudflareZone(
  data: NewCloudflareZone
): Promise<ActionResponse<{ id: string }>> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = cloudflareZoneInputSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  try {
    const created = one(
      await db
        .insert(cloudflareZones)
        .values({
          ...parsed.data,
          apiToken: encryptSecret(parsed.data.apiToken),
        })
        .returning(),
      "cloudflare zone"
    );
    revalidatePath(ADMIN_TUNNELS_PATH);
    return {
      success: true,
      message: t("zoneCreated"),
      data: { id: created.id },
    };
  } catch (error) {
    console.error("Failed to create Cloudflare zone:", error);
    return { success: false, message: t("zoneCreateFailed") };
  }
}

export async function updateCloudflareZone(
  id: string,
  data: Partial<NewCloudflareZone>
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = cloudflareZoneUpdateSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  // Empty/omitted apiToken means "keep the stored one" — drop it from the set.
  const patch = { ...parsed.data };
  if (patch.apiToken) patch.apiToken = encryptSecret(patch.apiToken);
  else delete patch.apiToken;

  try {
    const [updated] = await db
      .update(cloudflareZones)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(cloudflareZones.id, id))
      .returning();
    if (!updated) return { success: false, message: t("zoneNotFound") };
    revalidatePath(ADMIN_TUNNELS_PATH);
    return { success: true, message: t("zoneUpdated") };
  } catch (error) {
    console.error(`Failed to update Cloudflare zone ${id}:`, error);
    return { success: false, message: t("zoneUpdateFailed") };
  }
}

export async function deleteCloudflareZone(
  id: string
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  try {
    await db.delete(cloudflareZones).where(eq(cloudflareZones.id, id));
    revalidatePath(ADMIN_TUNNELS_PATH);
    return { success: true, message: t("zoneDeleted") };
  } catch (error) {
    // The FK is ON DELETE RESTRICT: a zone still backing a tunnel cannot go,
    // because its token is what publishes that tunnel's hostnames.
    console.error(`Failed to delete Cloudflare zone ${id}:`, error);
    return { success: false, message: t("zoneDeleteFailed") };
  }
}

/**
 * Probe a token without persisting it — mirrors testServerConnection. In edit
 * mode the token may be omitted, in which case the stored one is loaded by id.
 */
export async function testCloudflareZone(input: {
  zoneId: string;
  apiToken?: string;
  id?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");

  let apiToken = input.apiToken?.trim();
  if (!apiToken && input.id) {
    const [row] = await db
      .select({ apiToken: cloudflareZones.apiToken })
      .from(cloudflareZones)
      .where(eq(cloudflareZones.id, input.id))
      .limit(1);
    if (!row) return { ok: false, message: t("zoneNotFound") };
    apiToken = decryptSecret(row.apiToken);
  }
  if (!apiToken) return { ok: false, message: t("zoneTokenRequiredForTest") };

  try {
    await verifyZoneAccess({ zoneId: input.zoneId.trim(), apiToken });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// =========================
// Tunnels
// =========================

export async function getTunnels(): Promise<TunnelWithContext[]> {
  await requireAdmin();
  const rows = await db
    .select()
    .from(tunnels)
    .innerJoin(servers, eq(tunnels.serverId, servers.id))
    .innerJoin(cloudflareZones, eq(tunnels.zoneId, cloudflareZones.id))
    .orderBy(tunnels.name);

  return rows.map((row) => {
    const { password, ...server } = row.servers;
    const zone = row.cloudflare_zones;
    return {
      ...row.tunnels,
      server,
      zone: { id: zone.id, name: zone.name, zoneId: zone.zoneId },
    };
  });
}

export async function getTunnel(id: string): Promise<TunnelWithContext | null> {
  await requireAdmin();
  const [row] = await db
    .select()
    .from(tunnels)
    .innerJoin(servers, eq(tunnels.serverId, servers.id))
    .innerJoin(cloudflareZones, eq(tunnels.zoneId, cloudflareZones.id))
    .where(eq(tunnels.id, id))
    .limit(1);
  if (!row) return null;
  const { password, ...server } = row.servers;
  const zone = row.cloudflare_zones;
  return {
    ...row.tunnels,
    server,
    zone: { id: zone.id, name: zone.name, zoneId: zone.zoneId },
  };
}

export async function createTunnel(
  data: NewTunnel
): Promise<ActionResponse<{ id: string }>> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = tunnelInputSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  try {
    const created = one(
      await db.insert(tunnels).values(parsed.data).returning(),
      "tunnel"
    );
    revalidatePath(ADMIN_TUNNELS_PATH);
    return {
      success: true,
      message: t("tunnelCreated"),
      data: { id: created.id },
    };
  } catch (error) {
    console.error("Failed to register tunnel:", error);
    return { success: false, message: t("tunnelCreateFailed") };
  }
}

export async function updateTunnel(
  id: string,
  data: Partial<NewTunnel>
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = tunnelUpdateSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  try {
    const [updated] = await db
      .update(tunnels)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(tunnels.id, id))
      .returning();
    if (!updated) return { success: false, message: t("tunnelNotFound") };
    revalidatePath(ADMIN_TUNNELS_PATH);
    revalidatePath(`${ADMIN_TUNNELS_PATH}/${id}`);
    return { success: true, message: t("tunnelUpdated") };
  } catch (error) {
    console.error(`Failed to update tunnel ${id}:`, error);
    return { success: false, message: t("tunnelUpdateFailed") };
  }
}

/**
 * Forget a tunnel. Only the registration is removed — the tunnel keeps running
 * and keeps serving every hostname in its config, because this panel is not
 * where that config lives. Withdraw the routes first if that is the intent.
 */
export async function deleteTunnel(id: string): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  try {
    await db.delete(tunnels).where(eq(tunnels.id, id));
    revalidatePath(ADMIN_TUNNELS_PATH);
    return { success: true, message: t("tunnelDeleted") };
  } catch (error) {
    console.error(`Failed to delete tunnel ${id}:`, error);
    return { success: false, message: t("tunnelDeleteFailed") };
  }
}

// =========================
// Routes
// =========================

// A tunnel plus the two credentials acting on it needs: SSH to its host and the
// zone's Cloudflare token, both decrypted. Never returned to a client.
type LoadedTunnel = {
  tunnel: Tunnel;
  creds: SshCreds;
  zone: { zoneId: string; apiToken: string; name: string };
};

async function loadTunnel(id: string): Promise<LoadedTunnel | null> {
  const [row] = await db
    .select()
    .from(tunnels)
    .innerJoin(servers, eq(tunnels.serverId, servers.id))
    .innerJoin(cloudflareZones, eq(tunnels.zoneId, cloudflareZones.id))
    .where(eq(tunnels.id, id))
    .limit(1);
  if (!row) return null;
  return {
    tunnel: row.tunnels,
    creds: {
      host: row.servers.host,
      username: row.servers.username,
      password: decryptSecret(row.servers.password),
    },
    zone: {
      zoneId: row.cloudflare_zones.zoneId,
      apiToken: decryptSecret(row.cloudflare_zones.apiToken),
      name: row.cloudflare_zones.name,
    },
  };
}

export type RouteRow = IngressRoute & {
  dns: DnsCheck;
  // State of the origin container, or null when the origin is not a container
  // this panel can address (a bare IP, a unix socket, `hello_world`).
  origin: IngressRoute["origin"];
  originState: "running" | "stopped" | "not-found" | "unknown";
  // False when cloudflared shares no Docker network with the origin container,
  // which produces a 502 at the edge that reads like a broken application.
  reachable: boolean | null;
};

export type TunnelRoutesView = {
  routes: RouteRow[];
  containerState: "running" | "stopped" | "not-found";
  // Whether cloudflared is currently serving. Null when the container is not
  // running, so there is nothing to ask.
  ready: boolean | null;
  // Set when the host could not be reached at all; the table renders the
  // message instead of an empty ingress, so a dead SSH link never looks like a
  // tunnel with no hostnames.
  error?: string;
};

/**
 * The ingress table of one tunnel, read from its config.yml on the host and
 * annotated with what the panel can verify about each route.
 *
 * Nothing here is cached in the database on purpose: the file is the source of
 * truth, so a route added by hand on the server shows up here, and one deleted
 * by hand disappears — neither can leave this view showing a fiction.
 */
export async function getTunnelRoutes(id: string): Promise<TunnelRoutesView> {
  await requireAdmin();
  const loaded = await loadTunnel(id);
  if (!loaded) return { routes: [], containerState: "not-found", ready: null };
  const { tunnel, creds, zone } = loaded;

  let source: string;
  let state: "running" | "stopped" | "not-found";
  let ready: boolean | null = null;
  let tunnelNets: string[] = [];
  try {
    source = await readRemoteText(creds, configFilePath(tunnel));
    state = await containerState(creds, tunnel.containerName);
    if (state === "running") {
      tunnelNets = await containerNetworks(creds, tunnel.containerName);
    }
  } catch (error) {
    return {
      routes: [],
      containerState: "not-found",
      ready: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: IngressRoute[];
  try {
    parsed = parseIngress(source);
  } catch (error) {
    return {
      routes: [],
      containerState: state,
      ready: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const containers = await listContainers(creds).catch(() => []);
  const byName = new Map(containers.map((c) => [c.name, c]));

  const routes = await Promise.all(
    parsed.map(async (route): Promise<RouteRow> => {
      const container = route.origin
        ? byName.get(route.origin.host)
        : undefined;
      return {
        ...route,
        dns: await checkDnsRecord(zone, {
          name: route.hostname,
          tunnelId: tunnel.tunnelId,
        }),
        originState: route.origin
          ? (container?.state ?? "not-found")
          : "unknown",
        // null = not knowable here (the origin isn't a container on this host,
        // or the tunnel container is down so it has no networks to compare).
        reachable:
          container && tunnelNets.length > 0
            ? container.networks.some((n) => tunnelNets.includes(n))
            : null,
      };
    })
  );

  if (state === "running") {
    ready = await probeTunnelHealth(creds, tunnel.containerName)
      .then((health) => health.healthy)
      .catch(() => null);
  }

  return { routes, containerState: state, ready };
}

/** Containers on the tunnel's host, for the origin picker in the add dialog. */
export async function getOriginCandidates(id: string) {
  await requireAdmin();
  const loaded = await loadTunnel(id);
  if (!loaded) return [];
  try {
    const [containers, tunnelNets] = await Promise.all([
      listContainers(loaded.creds),
      containerNetworks(loaded.creds, loaded.tunnel.containerName).catch(
        (): string[] => []
      ),
    ]);
    return containers
      .filter((c) => c.name !== loaded.tunnel.containerName)
      .map((c) => ({
        ...c,
        // Pre-computed so the dialog can warn before the operator submits,
        // rather than after a failed preflight.
        reachable: c.networks.some((n) => tunnelNets.includes(n)),
      }));
  } catch (error) {
    console.error(`Failed to list containers for tunnel ${id}:`, error);
    return [];
  }
}

/**
 * Publish a hostname: edit ingress, apply, then create the DNS record.
 *
 * The order is deliberately the reverse of the manual runbook. Creating the
 * CNAME first would make the hostname resolve while nothing serves it, and
 * Cloudflare answers that with error 1016 — a live, broken hostname. Ingress
 * without DNS is the harmless failure: nothing resolves, nothing is wrong.
 *
 * Every step before the `mv` is reversible by doing nothing. After it, a failed
 * apply restores the backup and re-applies, so the tunnel never stays on a
 * configuration that was rejected at runtime.
 */
export async function createTunnelRoute(input: {
  tunnelId: string;
  label: string;
  originHost: string;
  originPort: number;
}): Promise<ActionResponse<{ hostname: string }>> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = tunnelRouteInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? t("invalidInput"),
    };
  }
  const { tunnelId, label, originHost, originPort } = parsed.data;

  const loaded = await loadTunnel(tunnelId);
  if (!loaded) return { success: false, message: t("tunnelNotFound") };
  const { tunnel, creds, zone } = loaded;
  const hostname = `${label}.${zone.name}`;
  const configPath = configFilePath(tunnel);

  try {
    // --- Preflight: everything that can say no before anything is written ---
    const originStatus = await containerState(creds, originHost);
    if (originStatus === "not-found") {
      return {
        success: false,
        message: t("routeOriginNotFound", { originHost }),
      };
    }
    if (originStatus !== "running") {
      return {
        success: false,
        message: t("routeOriginNotRunning", { originHost }),
      };
    }

    const [originNets, tunnelNets] = await Promise.all([
      containerNetworks(creds, originHost),
      containerNetworks(creds, tunnel.containerName),
    ]);
    if (!originNets.some((n) => tunnelNets.includes(n))) {
      return {
        success: false,
        message: t("routeNoSharedNetwork", {
          originHost,
          container: tunnel.containerName,
          network: originNets[0] ?? "?",
        }),
      };
    }

    const existingRecord = await findDnsRecord(zone, hostname);
    if (
      existingRecord &&
      existingRecord.content !== cnameTarget(tunnel.tunnelId)
    ) {
      return {
        success: false,
        message: t("routeDnsTaken", {
          hostname,
          content: existingRecord.content,
        }),
      };
    }

    // --- Edit, validated by cloudflared itself before it goes live ---
    const source = await readRemoteText(creds, configPath);
    const next = addRoute(source, {
      hostname,
      service: formatOrigin(originHost, originPort),
    });

    const image = await tunnelImage(creds, tunnel.containerName);
    const staged = await stageRemoteText(creds, configPath, next);
    try {
      await validateIngressFile(creds, { image, filePath: staged });
    } catch (error) {
      await discardStagedFile(creds, configPath);
      throw error;
    }
    await commitStagedFile(creds, configPath);

    // --- Apply, and put the old config back if the tunnel won't come up ---
    try {
      await applyStack(creds, tunnel.stackDir);
      // Assert the apply had an EFFECT before trusting the readiness probe: a
      // container that was never recreated stays healthy while still serving
      // the previous ingress, which would make this report a success it has
      // not earned.
      await assertConfigApplied(creds, {
        containerName: tunnel.containerName,
        configPath,
      });
      const health = await waitForTunnelHealth(creds, tunnel.containerName);
      if (!health.healthy) throw new Error(health.detail);
    } catch (error) {
      const restored = await restoreBackup(creds, configPath).catch(
        () => false
      );
      if (restored)
        await applyStack(creds, tunnel.stackDir).catch(() => undefined);
      return {
        success: false,
        message: t("routeApplyFailed", {
          detail: error instanceof Error ? error.message : String(error),
          rollback: restored ? t("routeRolledBack") : t("routeRollbackFailed"),
        }),
      };
    }

    // --- DNS last: now that something is actually serving the hostname ---
    if (!existingRecord) {
      await createCnameRecord(zone, {
        name: hostname,
        tunnelId: tunnel.tunnelId,
        comment: `Managed by OpsDeck — ${tunnel.name}`,
      });
    }

    await recordActivity({
      actorId: session.user.id,
      action: "tunnel.route.created",
      entityType: "tunnel",
      entityId: tunnel.id,
      data: {
        hostname,
        origin: formatOrigin(originHost, originPort),
        tunnel: tunnel.name,
      },
    });
    revalidatePath(`${ADMIN_TUNNELS_PATH}/${tunnel.id}`);
    return {
      success: true,
      message: t("routeCreated", { hostname }),
      data: { hostname },
    };
  } catch (error) {
    console.error(`Failed to publish ${hostname}:`, error);
    return {
      success: false,
      message: error instanceof Error ? error.message : t("routeCreateFailed"),
    };
  }
}

/**
 * Withdraw a hostname: remove the ingress rule and apply, THEN delete the DNS
 * record.
 *
 * This order is not interchangeable. A record left pointing at a tunnel that no
 * longer routes the hostname makes Cloudflare answer error 1016 instead of
 * simply not resolving — an orphan that looks alive. Removing DNS first would
 * leave the reverse: a window where the route still serves traffic nobody can
 * reach, which is harmless but pointless.
 */
export async function deleteTunnelRoute(input: {
  tunnelId: string;
  hostname: string;
}): Promise<ActionResponse> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");
  const hostname = tunnelHostnameSchema.safeParse(input.hostname);
  if (!hostname.success) return { success: false, message: t("invalidInput") };

  const loaded = await loadTunnel(input.tunnelId);
  if (!loaded) return { success: false, message: t("tunnelNotFound") };
  const { tunnel, creds, zone } = loaded;
  const configPath = configFilePath(tunnel);

  try {
    const source = await readRemoteText(creds, configPath);
    const next = removeRoute(source, hostname.data);

    const image = await tunnelImage(creds, tunnel.containerName);
    const staged = await stageRemoteText(creds, configPath, next);
    try {
      await validateIngressFile(creds, { image, filePath: staged });
    } catch (error) {
      await discardStagedFile(creds, configPath);
      throw error;
    }
    await commitStagedFile(creds, configPath);

    try {
      await applyStack(creds, tunnel.stackDir);
      // Assert the apply had an EFFECT before trusting the readiness probe: a
      // container that was never recreated stays healthy while still serving
      // the previous ingress, which would make this report a success it has
      // not earned.
      await assertConfigApplied(creds, {
        containerName: tunnel.containerName,
        configPath,
      });
      const health = await waitForTunnelHealth(creds, tunnel.containerName);
      if (!health.healthy) throw new Error(health.detail);
    } catch (error) {
      const restored = await restoreBackup(creds, configPath).catch(
        () => false
      );
      if (restored)
        await applyStack(creds, tunnel.stackDir).catch(() => undefined);
      return {
        success: false,
        message: t("routeApplyFailed", {
          detail: error instanceof Error ? error.message : String(error),
          rollback: restored ? t("routeRolledBack") : t("routeRollbackFailed"),
        }),
      };
    }

    // The ingress is gone, so the record can only produce a 1016 from here on.
    // A failure to delete it leaves exactly that, so it is reported rather than
    // swallowed — but the route itself is already withdrawn either way.
    const record = await findDnsRecord(zone, hostname.data);
    if (record) await deleteDnsRecord(zone, record.id);

    await recordActivity({
      actorId: session.user.id,
      action: "tunnel.route.deleted",
      entityType: "tunnel",
      entityId: tunnel.id,
      data: { hostname: hostname.data, tunnel: tunnel.name },
    });
    revalidatePath(`${ADMIN_TUNNELS_PATH}/${tunnel.id}`);
    return {
      success: true,
      message: t("routeDeleted", { hostname: hostname.data }),
    };
  } catch (error) {
    console.error(`Failed to withdraw ${input.hostname}:`, error);
    return {
      success: false,
      message: error instanceof Error ? error.message : t("routeDeleteFailed"),
    };
  }
}

/**
 * Attach the tunnel container to one more application network.
 *
 * The step a new application always needs: each app stack owns its own Docker
 * network, and an ingress rule pointing at a container cloudflared cannot reach
 * answers 502 from the edge — which reads like a broken application rather than
 * a routing gap. Offered when the preflight network check fails.
 */
export async function attachTunnelNetwork(input: {
  tunnelId: string;
  network: string;
}): Promise<ActionResponse> {
  const session = await requireAdmin();
  const t = await getTranslations("actionErrors");

  const loaded = await loadTunnel(input.tunnelId);
  if (!loaded) return { success: false, message: t("tunnelNotFound") };
  const { tunnel, creds } = loaded;
  const composePath = composeFilePath(tunnel.stackDir);

  try {
    const source = await readRemoteText(creds, composePath);
    const next = addExternalNetwork(source, {
      containerName: tunnel.containerName,
      realName: input.network,
    });
    if (next === source) {
      return { success: true, message: t("networkAlreadyAttached") };
    }

    await writeRemoteTextAtomically(creds, composePath, next, {
      keepBackup: true,
    });
    try {
      await validateCompose(creds, tunnel.stackDir);
      await applyStack(creds, tunnel.stackDir);
      // Same assertion as the route paths, against the file that changed here:
      // a container still older than the edited compose file is not attached to
      // the new network, however healthy it looks.
      await assertConfigApplied(creds, {
        containerName: tunnel.containerName,
        configPath: composePath,
      });
      const health = await waitForTunnelHealth(creds, tunnel.containerName);
      if (!health.healthy) throw new Error(health.detail);
    } catch (error) {
      const restored = await restoreBackup(creds, composePath).catch(
        () => false
      );
      if (restored)
        await applyStack(creds, tunnel.stackDir).catch(() => undefined);
      return {
        success: false,
        message: t("routeApplyFailed", {
          detail: error instanceof Error ? error.message : String(error),
          rollback: restored ? t("routeRolledBack") : t("routeRollbackFailed"),
        }),
      };
    }

    await recordActivity({
      actorId: session.user.id,
      action: "tunnel.network.attached",
      entityType: "tunnel",
      entityId: tunnel.id,
      data: { network: input.network, tunnel: tunnel.name },
    });
    revalidatePath(`${ADMIN_TUNNELS_PATH}/${tunnel.id}`);
    return {
      success: true,
      message: t("networkAttached", { network: input.network }),
    };
  } catch (error) {
    console.error(
      `Failed to attach ${input.network} to tunnel ${tunnel.id}:`,
      error
    );
    return {
      success: false,
      message:
        error instanceof Error ? error.message : t("networkAttachFailed"),
    };
  }
}
