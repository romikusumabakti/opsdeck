// The provisioning steps that publish an environment through a remotely-managed
// Cloudflare tunnel: the Access app (when a policy is set), the ingress route,
// then the DNS record.
//
// Each step is idempotent. An object that already exists exactly as wanted is
// reused without a write; one in another shape (a route to another service, an
// Access app or DNS record the Panel did not create for this environment) fails
// the step before anything is written, naming the clash. The Panel tags what it
// creates with `opsdeck:<environmentId>` (app name, record comment) and owns
// only what carries that tag.
//
// The hostname's DNS record is checked before the first write of a binding:
// the Access app step and the route step both fail, writing nothing, unless the
// record is absent or ours. So a hostname someone else already publishes (a
// production app on the same tunnel, a record pointing elsewhere) is never
// touched, whichever step runs first.

import {
  type AccessApp,
  type CloudflareCreds,
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
  getDomain,
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

async function loadZone(zoneRowId: string): Promise<string> {
  const zoneId = await getZoneCloudflareId(zoneRowId);
  if (!zoneId) throw new StepFailed(`Zone ${zoneRowId} not found`);
  return zoneId;
}

/**
 * The hostname's DNS record when it is ours, null when the name is free;
 * fails the step when anyone else's record holds the name. Runs before a
 * step's first write.
 */
async function requireHostnameFree(
  ctx: CloudflareStepContext,
  creds: CloudflareCreds,
  zoneId: string,
  hostname: string,
  tunnelId: string
): Promise<DnsRecord | null> {
  const existing = await findDnsRecord(creds, zoneId, hostname);
  if (existing && !isOwnRecord(existing, tunnelId, ctx.environmentId)) {
    throw new StepFailed(
      `DNS record ${existing.type} ${existing.content} already exists for ${hostname}`
    );
  }
  return existing;
}

/**
 * Adds `hostname` -> `service` to the tunnel's remote config. The DNS check
 * comes first: a same-service rule is adopted only when the hostname is not
 * published by someone else. The GET, the edit and the PUT run under one
 * advisory lock per Cloudflare tunnel, so two environments provisioned at
 * once on one tunnel cannot drop each other's route.
 */
export async function tunnelRoute(
  ctx: CloudflareStepContext,
  params: Params<"tunnel_route">
): Promise<string> {
  const { creds } = await loadAccount(ctx);
  const tunnel = await loadTunnel(params.remoteTunnelId);
  const zoneId = await loadZone(params.zoneId);
  await requireHostnameFree(
    ctx,
    creds,
    zoneId,
    params.hostname,
    tunnel.tunnelId
  );
  const changed = await withAdvisoryXactLock(
    `cf-tunnel:${tunnel.tunnelId}`,
    async () => {
      const current = await getTunnelConfig(creds, tunnel.tunnelId);
      // Throws CloudflareConflictError ("<hostname> already routes to …") or
      // UnsafeTunnelConfigError (no ingress or no catch-all to keep).
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

const hasPolicy = (app: AccessApp, policyId: string) =>
  (app.policies ?? []).some((policy) => policy.id === policyId);

/**
 * Protects the hostname with a self-hosted Access app bound to the policy.
 * The first Cloudflare step of a binding with a policy, so it checks the DNS
 * record before creating anything. A Panel-tagged app is reused only when it
 * carries the planned policy.
 */
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
  const tunnel = await loadTunnel(params.remoteTunnelId);
  const zoneId = await loadZone(params.zoneId);
  await requireHostnameFree(
    ctx,
    creds,
    zoneId,
    params.hostname,
    tunnel.tunnelId
  );
  const name = panelTag(ctx.environmentId);
  const existing = await findAccessAppByDomain(creds, params.hostname);
  if (existing && existing.name !== name) {
    throw new StepFailed(
      `Access app ${existing.name} already covers ${params.hostname}`
    );
  }
  if (existing && !hasPolicy(existing, params.policyId)) {
    throw new StepFailed(`Access app ${existing.name} uses another policy`);
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

/**
 * The binding's Access app, re-checked right before the hostname goes live:
 * when the binding has a policy, our tagged app must still cover the hostname
 * with that policy (someone may have deleted or edited it since its step ran).
 */
async function requireAccessApp(
  ctx: CloudflareStepContext,
  creds: CloudflareCreds,
  hostname: string
): Promise<void> {
  const binding = await getDomain(ctx.environmentId);
  if (!binding) {
    throw new StepFailed(`Environment ${ctx.environmentId} has no domain`);
  }
  if (!binding.accessPolicyId) return;
  const app = await findAccessAppByDomain(creds, hostname);
  if (!app || app.name !== panelTag(ctx.environmentId)) {
    throw new StepFailed(
      app
        ? `Access app ${app.name} covers ${hostname} instead of the Panel's`
        : `No Access app protects ${hostname}; retry the Access app step`
    );
  }
  if (!hasPolicy(app, binding.accessPolicyId)) {
    throw new StepFailed(`Access app ${app.name} uses another policy`);
  }
}

/**
 * Publishes the hostname as a proxied CNAME into the tunnel, after checking
 * that the Access app (when the binding has a policy) still protects it.
 */
export async function dnsRecord(
  ctx: CloudflareStepContext,
  params: Params<"dns_record">
): Promise<string> {
  const { creds } = await loadAccount(ctx);
  const tunnel = await loadTunnel(params.remoteTunnelId);
  const zoneId = await loadZone(params.zoneId);
  const existing = await requireHostnameFree(
    ctx,
    creds,
    zoneId,
    params.hostname,
    tunnel.tunnelId
  );
  await requireAccessApp(ctx, creds, params.hostname);
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
