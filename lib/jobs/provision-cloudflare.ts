// The provisioning steps that publish an environment through a remotely-managed
// Cloudflare tunnel: the ingress route, the Access app, then the DNS record.
//
// Each step is idempotent. An object that already exists exactly as wanted is
// reused without a write; one in another shape (a route to another service, an
// Access app or DNS record the Panel did not create for this environment) fails
// the step before anything is written, naming the clash. The Panel tags what it
// creates with `opsdeck:<environmentId>` (app name, record comment) and owns
// only what carries that tag.

import {
  createAccessApp,
  createProxiedCname,
  type DnsRecord,
  findAccessAppByDomain,
  findDnsRecord,
  getTunnelConfig,
  putTunnelConfig,
  withIngressRoute,
} from "@/lib/cloudflare/api";
import { DOMAIN_ERRORS } from "@/lib/domains/errors";
import {
  getRemoteTunnel,
  getZoneCloudflareId,
  setDomainAccessAppId,
  setDomainDnsRecordId,
} from "@/lib/domains/repository";
import type { ProvisioningStepSpec } from "@/lib/provisioning/plan";
import { withAdvisoryXactLock } from "@/lib/provisioning/repository";
import { loadCloudflareAccount } from "@/server/services/cloudflare-account";

/** An expected failure; its message is the whole story for the step. */
class StepFailed extends Error {}

type CloudflareStepContext = {
  environmentId: string;
  // Scrubbed from anything the job stores or logs; the token goes in here.
  secrets: string[];
};

type Params<K extends ProvisioningStepSpec["kind"]> = Extract<
  ProvisioningStepSpec,
  { kind: K }
>["params"];

const panelTag = (environmentId: string) => `opsdeck:${environmentId}`;

async function loadAccount(ctx: CloudflareStepContext) {
  const account = await loadCloudflareAccount();
  if (!account) throw new StepFailed(DOMAIN_ERRORS.cloudflareNotConfigured);
  // Cloudflare errors carry no token, but redaction costs nothing.
  ctx.secrets.push(account.creds.apiToken);
  return account;
}

async function loadTunnel(remoteTunnelId: string) {
  const tunnel = await getRemoteTunnel(remoteTunnelId);
  if (!tunnel)
    throw new StepFailed(`Remote tunnel ${remoteTunnelId} not found`);
  return tunnel;
}

/**
 * Adds `hostname` -> `service` to the tunnel's remote config. The GET, the
 * edit and the PUT run under one advisory lock per Cloudflare tunnel, so two
 * environments provisioned at once on one tunnel cannot drop each other's
 * route.
 */
export async function tunnelRoute(
  ctx: CloudflareStepContext,
  params: Params<"tunnel_route">
): Promise<string> {
  const { creds } = await loadAccount(ctx);
  const tunnel = await loadTunnel(params.remoteTunnelId);
  const changed = await withAdvisoryXactLock(
    `cf-tunnel:${tunnel.tunnelId}`,
    async () => {
      const current = await getTunnelConfig(creds, tunnel.tunnelId);
      // Throws CloudflareConflictError ("<hostname> already routes to …").
      const next = withIngressRoute(current, params.hostname, params.service);
      if (next.changed) {
        await putTunnelConfig(creds, tunnel.tunnelId, next.config);
      }
      return next.changed;
    }
  );
  return changed
    ? `Route ${params.hostname} → ${params.service} added on ${tunnel.name}`
    : `Route ${params.hostname} → ${params.service} already on ${tunnel.name}`;
}

/** Protects the hostname with a self-hosted Access app bound to the policy. */
export async function accessApp(
  ctx: CloudflareStepContext,
  params: Params<"access_app">
): Promise<string> {
  const { creds, accessIdpId } = await loadAccount(ctx);
  if (!accessIdpId) {
    throw new StepFailed(
      "Cloudflare account has no Access identity provider set"
    );
  }
  const name = panelTag(ctx.environmentId);
  const existing = await findAccessAppByDomain(creds, params.hostname);
  if (existing && existing.name !== name) {
    throw new StepFailed(
      `Access app ${existing.name} already covers ${params.hostname}`
    );
  }
  const app =
    existing ??
    (await createAccessApp(creds, {
      name,
      domain: params.hostname,
      policyId: params.policyId,
      idpId: accessIdpId,
    }));
  await setDomainAccessAppId(ctx.environmentId, app.id);
  return existing
    ? `Access app ${name} for ${params.hostname} already exists`
    : `Access app ${name} created for ${params.hostname}`;
}

// Ours: exactly what createProxiedCname makes for this environment.
function isOwnRecord(
  record: DnsRecord,
  tunnelId: string,
  environmentId: string
): boolean {
  return (
    record.type === "CNAME" &&
    record.content.toLowerCase() ===
      `${tunnelId}.cfargotunnel.com`.toLowerCase() &&
    record.proxied === true &&
    record.comment === panelTag(environmentId)
  );
}

/** Publishes the hostname as a proxied CNAME into the tunnel. */
export async function dnsRecord(
  ctx: CloudflareStepContext,
  params: Params<"dns_record">
): Promise<string> {
  const { creds } = await loadAccount(ctx);
  const tunnel = await loadTunnel(params.remoteTunnelId);
  const zoneId = await getZoneCloudflareId(params.zoneId);
  if (!zoneId) throw new StepFailed(`Zone ${params.zoneId} not found`);
  const existing = await findDnsRecord(creds, zoneId, params.hostname);
  if (existing && !isOwnRecord(existing, tunnel.tunnelId, ctx.environmentId)) {
    throw new StepFailed(
      `DNS record ${existing.type} ${existing.content} already exists for ${params.hostname}`
    );
  }
  const record =
    existing ??
    (await createProxiedCname(
      creds,
      zoneId,
      params.hostname,
      tunnel.tunnelId,
      panelTag(ctx.environmentId)
    ));
  await setDomainDnsRecordId(ctx.environmentId, record.id);
  return existing
    ? `DNS record ${params.hostname} already published`
    : `DNS record ${params.hostname} published`;
}
