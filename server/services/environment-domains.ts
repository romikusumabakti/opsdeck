import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { listAccessPolicies } from "@/lib/cloudflare/api";
import { DOMAIN_ERRORS } from "@/lib/domains/errors";
import {
  deleteDomain,
  getDomain,
  getDomainView,
  getEnvironmentRow,
  getRemoteTunnelByServer,
  getZone,
  hostnameTakenByOther,
  listDeployServerIds,
  listZones,
  saveDomain,
} from "@/lib/domains/repository";
import { type DomainInput, hostnameFor } from "@/lib/domains/validation";
import { canOrg } from "@/lib/permissions";
import { notFound } from "@/server/errors";
import { callCloudflare } from "@/server/services/cloudflare-account";

/**
 * An environment's public domain: through a registered remote tunnel (the
 * Panel provisions it later) or an external hostname (recorded only). Reading
 * needs project `deploy:view`, changing it `deploy:configure`. Publishing
 * without an Access policy also needs org `server:manage`.
 */

const VIEW = { deploy: ["view"] } as const;
const CONFIGURE = { deploy: ["configure"] } as const;

const fail = (status: 403 | 409 | 422, message: string): never => {
  throw new HTTPException(status, { message });
};

// The provisioning steps wrote to Cloudflare once either id is set.
const isProvisioned = (domain: {
  accessAppId: string | null;
  dnsRecordId: string | null;
}) => !!(domain.accessAppId || domain.dnsRecordId);

/** The one server the environment's deploy targets run on. */
async function resolveDeployServerId(environmentId: string): Promise<string> {
  const serverIds = await listDeployServerIds(environmentId);
  if (serverIds.length === 0) return fail(422, DOMAIN_ERRORS.domainNoTargets);
  if (serverIds.length > 1) return fail(422, DOMAIN_ERRORS.domainMultiServer);
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
      provisioned: isProvisioned(domain),
    },
  };
}

/** Reusable Access policies for the select; needs the Cloudflare account. */
export async function listDomainAccessPolicies(environmentId: string) {
  await requireProjectPermission({ environmentId }, CONFIGURE);
  return callCloudflare(listAccessPolicies);
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
  if (current && isProvisioned(current)) {
    return fail(409, DOMAIN_ERRORS.domainProvisioned);
  }

  if (input.kind === "external") {
    if (await hostnameTakenByOther(input.hostname, environmentId)) {
      return fail(409, DOMAIN_ERRORS.domainHostnameTaken);
    }
    await saveDomain(environmentId, {
      kind: "external",
      hostname: input.hostname,
      zoneId: null,
      remoteTunnelId: null,
      accessPolicyId: null,
    });
    await record(
      session.user.id,
      environmentId,
      environment.name,
      input.hostname,
      "external"
    );
    return { hostname: input.hostname };
  }

  // Going public is an org-level call; refuse before any lookup.
  if (
    input.accessPolicyId === null &&
    !canOrg(session.user.role, { server: ["manage"] })
  ) {
    return fail(403, DOMAIN_ERRORS.domainPublicForbidden);
  }

  const serverId = await resolveDeployServerId(environmentId);
  const tunnel = await getRemoteTunnelByServer(serverId);
  if (!tunnel) return fail(422, DOMAIN_ERRORS.domainNoTunnel);
  const zone = await getZone(input.zoneId);
  if (!zone) return fail(422, DOMAIN_ERRORS.domainUnknownZone);

  const hostname = hostnameFor(input.label, zone.name);
  if (await hostnameTakenByOther(hostname, environmentId)) {
    return fail(409, DOMAIN_ERRORS.domainHostnameTaken);
  }

  // Checked against the account now, not cached: a deleted policy must not be
  // bound.
  if (input.accessPolicyId !== null) {
    const policyId = input.accessPolicyId;
    const policies = await callCloudflare(listAccessPolicies);
    if (!policies.some((p) => p.id === policyId)) {
      return fail(422, DOMAIN_ERRORS.domainUnknownPolicy);
    }
  }

  try {
    await saveDomain(
      environmentId,
      {
        kind: "tunnel",
        hostname,
        zoneId: zone.id,
        remoteTunnelId: tunnel.id,
        accessPolicyId: input.accessPolicyId,
      },
      input.entryPort
    );
  } catch (error) {
    // Two requests raced for the same hostname.
    if ((error as { code?: string }).code === "23505") {
      return fail(409, DOMAIN_ERRORS.domainHostnameTaken);
    }
    throw error;
  }
  await record(
    session.user.id,
    environmentId,
    environment.name,
    hostname,
    "tunnel"
  );
  return { hostname };
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
  if (isProvisioned(current)) return fail(409, DOMAIN_ERRORS.domainProvisioned);
  await deleteDomain(environmentId);
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
