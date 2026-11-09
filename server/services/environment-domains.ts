import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireOrgPermission, requireProjectPermission } from "@/lib/authz";
import {
  type AccessApp,
  accessAppDomains,
  CloudflareConflictError,
  type CloudflareCreds,
  findDnsRecord,
  getTunnelConfig,
  listAccessAppsByDomain,
  listAccessPolicies,
  putTunnelConfig,
  UnsafeTunnelConfigError,
  withIngressRoute,
} from "@/lib/cloudflare/api";
import {
  DOMAIN_ERRORS,
  type DomainErrorCode,
  pgErrorCode,
} from "@/lib/domains/errors";
import {
  adoptDomain,
  type DomainSaveResult,
  deleteDomain,
  getDomain,
  getDomainView,
  getEnvironmentRow,
  getRemoteTunnel,
  getRemoteTunnelByServer,
  getZone,
  getZoneCloudflareId,
  hasProvisioningProgress,
  hostnameTakenByOther,
  listDeployServerIds,
  listZones,
  saveDomain,
} from "@/lib/domains/repository";
import {
  type AdoptDomainInput,
  type DomainInput,
  hostnameFor,
  isPublicPolicy,
  isUnderZone,
  zoneOf,
} from "@/lib/domains/validation";
import { canOrg } from "@/lib/permissions";
import { ENTRY_PORT_RANGE } from "@/lib/provisioning/ports";
import { withAdvisoryXactLock } from "@/lib/provisioning/repository";
import { TEARDOWN_ERRORS } from "@/lib/teardown/errors";
import { teardownBlocks } from "@/lib/teardown/guard";
import { CodedHTTPException, notFound } from "@/server/errors";
import { callCloudflare } from "@/server/services/cloudflare-account";
import { listEntryPortsOnServer } from "@/server/services/preflight-repository";

/**
 * An environment's public domain: through a registered remote tunnel (the
 * Panel provisions it later) or an external hostname (recorded only). Reading
 * needs project `deploy:view`, changing it `deploy:configure`. Publishing
 * without an Access policy, or an entry port outside the Panel's free-port
 * range, also needs org `server:manage`. No caller may pick a port another
 * environment on the same server already uses: the tunnel would route the
 * hostname into that environment.
 */

const VIEW = { deploy: ["view"] } as const;
const CONFIGURE = { deploy: ["configure"] } as const;

const fail = (status: 403 | 409 | 422, message: string): never => {
  throw new HTTPException(status, { message });
};

// The provisioning steps wrote to Cloudflare once either id is set, or once a
// Cloudflare step is done or running (tunnel_route writes no id). The writes
// below repeat this check in SQL, so a step starting between this read and the
// write still cannot be overwritten.
async function isProvisioned(
  environmentId: string,
  domain?: { accessAppId: string | null; dnsRecordId: string | null }
): Promise<boolean> {
  if (domain?.accessAppId || domain?.dnsRecordId) return true;
  return hasProvisioningProgress(environmentId);
}

/** 409 `teardownRunning`: the environment is being deleted. */
function failTearingDown(): never {
  throw new CodedHTTPException(
    409,
    "teardownRunning",
    TEARDOWN_ERRORS.teardownRunning
  );
}

// Writes the binding; maps the guarded results and a hostname race.
async function store(
  environmentId: string,
  ...args: Parameters<typeof saveDomain> extends [string, ...infer R]
    ? R
    : never
) {
  let result: DomainSaveResult;
  try {
    result = await saveDomain(environmentId, ...args);
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      fail(409, DOMAIN_ERRORS.domainHostnameTaken);
    }
    throw error;
  }
  if (result === "tearingDown") failTearingDown();
  if (result === "provisioned") fail(409, DOMAIN_ERRORS.domainProvisioned);
}

// Policies that let anyone in count as public: only an org server:manage
// holder may bind them, and others are not offered them.
const canPublish = (role: string | null | undefined) =>
  canOrg(role, { server: ["manage"] });

const inFreePortRange = (port: number) =>
  port >= ENTRY_PORT_RANGE.from && port <= ENTRY_PORT_RANGE.to;

/** The one server the environment's deploy targets run on. */
async function resolveDeployServerId(environmentId: string): Promise<string> {
  const serverIds = await listDeployServerIds(environmentId);
  if (serverIds.length === 0) return failDomain(422, "domainNoTargets");
  if (serverIds.length > 1) return failDomain(422, "domainMultiServer");
  return serverIds[0] as string;
}

export async function getEnvironmentDomain(environmentId: string) {
  await requireProjectPermission({ environmentId }, VIEW);
  const environment = await getEnvironmentRow(environmentId);
  if (!environment) notFound();
  const [view, zones] = await Promise.all([
    getDomainView(environmentId),
    listZones(),
  ]);
  const domain = view?.domain ?? null;
  const provisioned = domain
    ? await isProvisioned(environmentId, domain)
    : false;
  return {
    entryPort: environment?.entryPort ?? null,
    zones,
    domain: domain && {
      kind: domain.kind,
      hostname: domain.hostname,
      zoneId: domain.zoneId,
      // The label the form edits: the hostname minus `.<zone>`.
      label:
        domain.kind === "tunnel" && view?.zoneName
          ? domain.hostname.slice(0, -(view.zoneName.length + 1))
          : null,
      tunnelName: view?.tunnelName ?? null,
      accessPolicyId: domain.accessPolicyId,
      provisioned,
    },
  };
}

/** The account's reusable Access policies, without public ones for non-admins. */
async function visibleAccessPolicies(role: string | null | undefined) {
  const policies = await callCloudflare(listAccessPolicies);
  return policies
    .filter((p) => canPublish(role) || !isPublicPolicy(p))
    .map(({ id, name }) => ({ id, name }));
}

/** Reusable Access policies for the select; needs the Cloudflare account. */
export async function listDomainAccessPolicies(environmentId: string) {
  const { session } = await requireProjectPermission(
    { environmentId },
    CONFIGURE
  );
  return visibleAccessPolicies(session.user.role);
}

/**
 * The same list for an environment that does not exist yet (the setup
 * wizard's domain section), by the project it will be in.
 */
export async function listProjectAccessPolicies(projectId: string) {
  const { session } = await requireProjectPermission({ projectId }, CONFIGURE);
  return visibleAccessPolicies(session.user.role);
}

/**
 * Fails with the domain refusal `code`: its DOMAIN_ERRORS message, and the
 * code for the setup preview (server/errors#errorCode).
 */
function failDomain(status: 403 | 409 | 422, code: DomainErrorCode): never {
  throw new CodedHTTPException(status, code, DOMAIN_ERRORS[code]);
}

type DomainWrite = {
  kind: "tunnel" | "external";
  hostname: string;
  zoneId: string | null;
  remoteTunnelId: string | null;
  accessPolicyId: string | null;
};

/**
 * Every rule a domain binding must pass, in this order: for an external
 * hostname, unused by other environments and not under a registered zone;
 * for a tunnel, Access unless the caller may publish, an entry port in the
 * free range unless the caller may publish, the port unused on the deploy
 * server, the server's tunnel, the zone, the hostname unused, and the Access
 * policy in the account (a public one only for publishers). `deployServerId`
 * is asked for only after the checks that need no lookup. `environmentId` is
 * the environment the binding is for, when it exists already. Returns the row
 * to store and, for a tunnel, the entry port and the tunnel's origin host.
 */
export async function validateDomainBinding(
  orgRole: string | null | undefined,
  input: DomainInput,
  {
    environmentId,
    deployServerId,
  }: { environmentId?: string; deployServerId: () => Promise<string> }
): Promise<{ write: DomainWrite; entryPort?: number; originHost?: string }> {
  if (input.kind === "external") {
    if (await hostnameTakenByOther(input.hostname, environmentId)) {
      return failDomain(409, "domainHostnameTaken");
    }
    // Under a registered zone the Panel can do better than a record.
    const zoneNames = (await listZones()).map((z) => z.name);
    if (isUnderZone(input.hostname, zoneNames)) {
      return failDomain(422, "domainExternalInZone");
    }
    return {
      write: {
        kind: "external",
        hostname: input.hostname,
        zoneId: null,
        remoteTunnelId: null,
        accessPolicyId: null,
      },
    };
  }

  // Going public is an org-level call; refuse before any lookup.
  if (input.accessPolicyId === null && !canPublish(orgRole)) {
    return failDomain(403, "domainPublicForbidden");
  }
  // Outside the free-port range sit the server's own services (the Panel,
  // CI, production apps): pointing a hostname there is an org-level call.
  if (!inFreePortRange(input.entryPort) && !canPublish(orgRole)) {
    return failDomain(403, "domainPortForbidden");
  }

  const serverId = await deployServerId();
  const taken = await listEntryPortsOnServer(serverId, environmentId);
  if (taken.includes(input.entryPort)) {
    return failDomain(409, "domainPortInUse");
  }
  const tunnel = await getRemoteTunnelByServer(serverId);
  if (!tunnel) return failDomain(422, "domainNoTunnel");
  const zone = await getZone(input.zoneId);
  if (!zone) return failDomain(422, "domainUnknownZone");

  const hostname = hostnameFor(input.label, zone.name);
  if (await hostnameTakenByOther(hostname, environmentId)) {
    return failDomain(409, "domainHostnameTaken");
  }

  // Checked against the account now, not cached: a deleted policy must not be
  // bound.
  if (input.accessPolicyId !== null) {
    const policyId = input.accessPolicyId;
    const policies = await callCloudflare(listAccessPolicies);
    const policy = policies.find((p) => p.id === policyId);
    if (!policy) return failDomain(422, "domainUnknownPolicy");
    // A bypass or Everyone policy is a public binding by another name.
    if (isPublicPolicy(policy) && !canPublish(orgRole)) {
      return failDomain(403, "domainPublicForbidden");
    }
  }

  return {
    write: {
      kind: "tunnel",
      hostname,
      zoneId: zone.id,
      remoteTunnelId: tunnel.id,
      accessPolicyId: input.accessPolicyId,
    },
    entryPort: input.entryPort,
    originHost: tunnel.originHost,
  };
}

export async function putEnvironmentDomain(
  environmentId: string,
  input: DomainInput
) {
  const { session } = await requireProjectPermission(
    { environmentId },
    CONFIGURE
  );
  const environment = await getEnvironmentRow(environmentId);
  if (!environment) notFound();

  const current = await getDomain(environmentId);
  if (await isProvisioned(environmentId, current)) {
    return fail(409, DOMAIN_ERRORS.domainProvisioned);
  }

  const { write, entryPort } = await validateDomainBinding(
    session.user.role,
    input,
    {
      environmentId,
      deployServerId: () => resolveDeployServerId(environmentId),
    }
  );
  await store(environmentId, write, entryPort);
  await record(
    session.user.id,
    environmentId,
    environment.name,
    write.hostname,
    write.kind
  );
  return { hostname: write.hostname };
}

export async function deleteEnvironmentDomain(environmentId: string) {
  const { session } = await requireProjectPermission(
    { environmentId },
    CONFIGURE
  );
  const environment = await getEnvironmentRow(environmentId);
  if (!environment) notFound();
  const current = await getDomain(environmentId);
  if (!current) return;
  if (await isProvisioned(environmentId, current)) {
    return fail(409, DOMAIN_ERRORS.domainProvisioned);
  }
  // The delete repeats the check in SQL; no row means a step started meanwhile.
  if (!(await deleteDomain(environmentId))) {
    return fail(409, DOMAIN_ERRORS.domainProvisioned);
  }
  await recordActivity({
    actorId: session.user.id,
    action: "environment.domain.delete",
    entityType: "environment",
    entityId: environmentId,
    data: { environment: environment.name, hostname: current.hostname },
  });
}

/**
 * Records a hostname Cloudflare already publishes through a registered remote
 * tunnel as the environment's tunnel domain, so its teardown removes it later.
 * Org `server:manage` only. The hostname must be under a registered zone and
 * have a CNAME into that tunnel; the Access app covering exactly it (if any) is
 * recorded, never created, so the hostname's exposure stays as it is. The
 * tunnel route is added only when missing; a route to another service is
 * refused rather than rewritten. Only an environment without a domain.
 */
export async function adoptEnvironmentDomain(
  environmentId: string,
  input: AdoptDomainInput
) {
  const session = await requireOrgPermission({ server: ["manage"] });
  const environment = await getEnvironmentRow(environmentId);
  if (!environment) notFound();
  if (await getDomain(environmentId)) {
    return failDomain(409, "domainProvisioned");
  }
  // Checked again inside the write; this one keeps a teardown's environment
  // from getting a tunnel route the teardown would not remove.
  if (await teardownBlocks(environmentId)) failTearingDown();
  const { hostname, service } = input;
  if (await hostnameTakenByOther(hostname, environmentId)) {
    return failDomain(409, "domainHostnameTaken");
  }
  const zone = zoneOf(hostname, await listZones());
  const cfZoneId = zone && (await getZoneCloudflareId(zone.id));
  if (!zone || !cfZoneId) return failDomain(422, "domainUnknownZone");
  const tunnel = await getRemoteTunnel(input.remoteTunnelId);
  if (!tunnel) return failDomain(422, "tunnelUnknown");

  const { dnsRecordId, accessAppId } = await callCloudflare(async (creds) => {
    const found = await findAdoptable(
      creds,
      cfZoneId,
      hostname,
      tunnel.tunnelId
    );
    await addRouteIfMissing(creds, tunnel.tunnelId, hostname, service);
    return found;
  });

  let result: DomainSaveResult;
  try {
    result = await adoptDomain(environmentId, {
      kind: "tunnel",
      hostname,
      zoneId: zone.id,
      remoteTunnelId: tunnel.id,
      accessPolicyId: null,
      accessAppId,
      dnsRecordId,
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      return failDomain(409, "domainHostnameTaken");
    }
    throw error;
  }
  if (result === "tearingDown") failTearingDown();
  if (result === "provisioned") failDomain(409, "domainProvisioned");
  await recordActivity({
    actorId: session.user.id,
    action: "environment.domain.adopted",
    entityType: "environment",
    entityId: environmentId,
    data: { environment: environment.name, hostname },
  });
  return { hostname };
}

/**
 * The hostname's CNAME into the tunnel and its Access app (null when none),
 * read before anything is written. An app that covers other hostnames too is
 * refused: deleting it at teardown would expose them.
 */
async function findAdoptable(
  creds: CloudflareCreds,
  zoneId: string,
  hostname: string,
  tunnelId: string
): Promise<{ dnsRecordId: string; accessAppId: string | null }> {
  const record = await findDnsRecord(creds, zoneId, hostname);
  if (
    record?.type !== "CNAME" ||
    record.content.toLowerCase() !==
      `${tunnelId}.cfargotunnel.com`.toLowerCase()
  ) {
    return failDomain(409, "hostnameNotOnTunnel");
  }
  const apps = await listAccessAppsByDomain(creds, hostname);
  if (apps.length > 1) return failDomain(409, "domainAccessAppAmbiguous");
  const app = apps[0];
  if (app && accessAppHostnames(app).some((name) => name !== hostname)) {
    return failDomain(409, "domainAccessAppShared");
  }
  return { dnsRecordId: record.id, accessAppId: app?.id ?? null };
}

// The hostnames an Access app covers, lowercased: a destination's path
// (`host/path`) is dropped, and an absent domain skipped.
function accessAppHostnames(app: AccessApp): string[] {
  return accessAppDomains(app).map(
    (domain) => domain.split("/")[0]?.toLowerCase() ?? ""
  );
}

// The same lock as the provisioning tunnel_route step, so concurrent edits of
// one tunnel's config cannot drop each other's route.
async function addRouteIfMissing(
  creds: CloudflareCreds,
  tunnelId: string,
  hostname: string,
  service: string
): Promise<void> {
  await withAdvisoryXactLock(`cf-tunnel:${tunnelId}`, async () => {
    const current = await getTunnelConfig(creds, tunnelId);
    let next: ReturnType<typeof withIngressRoute>;
    try {
      next = withIngressRoute(current, hostname, service);
    } catch (error) {
      if (error instanceof CloudflareConflictError) {
        return failDomain(409, "domainRouteConflict");
      }
      if (error instanceof UnsafeTunnelConfigError) {
        return failDomain(409, "domainTunnelConfigUnsafe");
      }
      throw error;
    }
    if (next.changed) await putTunnelConfig(creds, tunnelId, next.config);
  });
}

async function record(
  actorId: string,
  environmentId: string,
  environmentName: string,
  hostname: string,
  kind: string
) {
  await recordActivity({
    actorId,
    action: "environment.domain.update",
    entityType: "environment",
    entityId: environmentId,
    data: { environment: environmentName, hostname, kind },
  });
}
