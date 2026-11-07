import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { listAccessPolicies } from "@/lib/cloudflare/api";
import {
  DOMAIN_ERRORS,
  type DomainErrorCode,
  pgErrorCode,
} from "@/lib/domains/errors";
import {
  deleteDomain,
  getDomain,
  getDomainView,
  getEnvironmentRow,
  getRemoteTunnelByServer,
  getZone,
  hasProvisioningProgress,
  hostnameTakenByOther,
  listDeployServerIds,
  listZones,
  saveDomain,
} from "@/lib/domains/repository";
import {
  type DomainInput,
  hostnameFor,
  isPublicPolicy,
  isUnderZone,
} from "@/lib/domains/validation";
import { canOrg } from "@/lib/permissions";
import { ENTRY_PORT_RANGE } from "@/lib/provisioning/ports";
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

// Writes the binding; maps the guarded no-row result and a hostname race.
async function store(
  environmentId: string,
  ...args: Parameters<typeof saveDomain> extends [string, ...infer R]
    ? R
    : never
) {
  try {
    if (!(await saveDomain(environmentId, ...args))) {
      fail(409, DOMAIN_ERRORS.domainProvisioned);
    }
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      fail(409, DOMAIN_ERRORS.domainHostnameTaken);
    }
    throw error;
  }
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

/** Reusable Access policies for the select; needs the Cloudflare account. */
export async function listDomainAccessPolicies(environmentId: string) {
  const { session } = await requireProjectPermission(
    { environmentId },
    CONFIGURE
  );
  const policies = await callCloudflare(listAccessPolicies);
  return policies
    .filter((p) => canPublish(session.user.role) || !isPublicPolicy(p))
    .map(({ id, name }) => ({ id, name }));
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
