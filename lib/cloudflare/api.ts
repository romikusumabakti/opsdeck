// Account-scoped Cloudflare calls: remotely-managed tunnel configuration,
// reusable Access policies and apps, identity providers, and the DNS record a
// tunnel hostname needs. One API token covers all of it (see
// cloudflare_accounts); every call takes it with the account id as `creds`.
//
// Hand-written on purpose, like lib/tunnels/cloudflare.ts: a few endpoints
// do not justify an SDK that can reach every Cloudflare product.

import {
  CloudflareApiError,
  request,
  requestWithInfo,
} from "@/lib/cloudflare/request";

export { CloudflareApiError };

export type CloudflareCreds = { accountId: string; apiToken: string };

/** A hostname already routes to a different service than the one wanted. */
export class CloudflareConflictError extends Error {}

export type IngressRule = {
  hostname?: string;
  service: string;
  [key: string]: unknown;
};

/** The remote tunnel config; unknown keys are carried through untouched. */
export type TunnelConfig = {
  ingress: IngressRule[];
  [key: string]: unknown;
};

const PER_PAGE = 100;

function account(creds: CloudflareCreds): string {
  return `/accounts/${encodeURIComponent(creds.accountId)}`;
}

/** Every item of a paginated list, following `result_info.total_pages`. */
async function listAll<T>(
  creds: CloudflareCreds,
  path: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({
      ...params,
      page: String(page),
      per_page: String(PER_PAGE),
    });
    const { result, info } = await requestWithInfo<T[]>(
      creds.apiToken,
      `${account(creds)}${path}?${query}`
    );
    items.push(...result);
    totalPages = info.total_pages ?? 1;
    page++;
  } while (page <= totalPages);
  return items;
}

// --- Verification and tunnels ---

/**
 * Check the token against the account: lists tunnels (Tunnel permission) and
 * reads Access policies (Access permission). Returns the tunnel count.
 */
export async function verifyAccount(
  creds: CloudflareCreds
): Promise<{ tunnels: number }> {
  const { result, info } = await requestWithInfo<unknown[]>(
    creds.apiToken,
    `${account(creds)}/cfd_tunnel?is_deleted=false&per_page=1`
  );
  await request<unknown[]>(
    creds.apiToken,
    `${account(creds)}/access/policies?per_page=1`
  );
  return { tunnels: info.total_count ?? result.length };
}

type RawTunnel = {
  id: string;
  name: string;
  status: string;
  remote_config?: boolean;
};

export async function listTunnels(creds: CloudflareCreds): Promise<
  {
    id: string;
    name: string;
    status: string;
    remoteConfig: boolean;
  }[]
> {
  const tunnels = await listAll<RawTunnel>(creds, "/cfd_tunnel", {
    is_deleted: "false",
  });
  return tunnels.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    remoteConfig: t.remote_config === true,
  }));
}

function configPath(creds: CloudflareCreds, tunnelId: string): string {
  return `${account(creds)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;
}

export async function getTunnelConfig(
  creds: CloudflareCreds,
  tunnelId: string
): Promise<TunnelConfig> {
  const result = await request<{ config?: Partial<TunnelConfig> | null }>(
    creds.apiToken,
    configPath(creds, tunnelId)
  );
  const config = result.config ?? {};
  return { ...config, ingress: config.ingress ?? [] };
}

/** Replace the whole config; callers pass what getTunnelConfig returned, edited. */
export async function putTunnelConfig(
  creds: CloudflareCreds,
  tunnelId: string,
  config: TunnelConfig
): Promise<void> {
  await request<unknown>(creds.apiToken, configPath(creds, tunnelId), {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
}

function isCatchAll(rule: IngressRule): boolean {
  return rule.hostname === undefined;
}

/**
 * The config with an ingress rule `hostname` -> `service`, without mutating
 * `config`. The rule goes just before the catch-all (the rule with no
 * hostname); a config without one gets the rule plus a `http_status:404`
 * catch-all, which cloudflared requires last. Everything else is preserved.
 * A hostname that already routes to another service is a conflict, never an
 * overwrite.
 */
export function withIngressRoute(
  config: TunnelConfig,
  hostname: string,
  service: string
): { config: TunnelConfig; changed: boolean } {
  const existing = config.ingress.find((rule) => rule.hostname === hostname);
  if (existing) {
    if (existing.service === service) return { config, changed: false };
    throw new CloudflareConflictError(
      `${hostname} already routes to ${existing.service}`
    );
  }
  const next = structuredClone(config);
  const catchAllAt = next.ingress.findLastIndex(isCatchAll);
  const rule: IngressRule = { hostname, service };
  if (catchAllAt === -1) {
    next.ingress.push(rule, { service: "http_status:404" });
  } else {
    next.ingress.splice(catchAllAt, 0, rule);
  }
  return { config: next, changed: true };
}

// --- DNS ---

export type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  comment?: string | null;
};

/** The DNS record named `name` in the zone, or null when the name is free. */
export async function findDnsRecord(
  creds: CloudflareCreds,
  zoneId: string,
  name: string
): Promise<DnsRecord | null> {
  const records = await request<DnsRecord[]>(
    creds.apiToken,
    `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}`
  );
  return records[0] ?? null;
}

/**
 * The proxied CNAME that routes `name` into the tunnel. Proxied is not a
 * preference: `<id>.cfargotunnel.com` only resolves inside Cloudflare's edge.
 */
export async function createProxiedCname(
  creds: CloudflareCreds,
  zoneId: string,
  name: string,
  tunnelId: string,
  comment: string
): Promise<DnsRecord> {
  return request<DnsRecord>(
    creds.apiToken,
    `/zones/${encodeURIComponent(zoneId)}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        comment,
      }),
    }
  );
}

// --- Access ---

/** Reusable Access policies of the account. */
export async function listAccessPolicies(
  creds: CloudflareCreds
): Promise<{ id: string; name: string }[]> {
  const policies = await listAll<{ id: string; name: string }>(
    creds,
    "/access/policies"
  );
  return policies.map((p) => ({ id: p.id, name: p.name }));
}

export async function listIdentityProviders(
  creds: CloudflareCreds
): Promise<{ id: string; name: string; type: string }[]> {
  const providers = await listAll<{ id: string; name: string; type: string }>(
    creds,
    "/access/identity_providers"
  );
  return providers.map((p) => ({ id: p.id, name: p.name, type: p.type }));
}

export type AccessApp = {
  id: string;
  name: string;
  domain: string;
  policies?: { id: string }[];
};

/** The Access app whose domain is exactly `domain`, or null. */
export async function findAccessAppByDomain(
  creds: CloudflareCreds,
  domain: string
): Promise<AccessApp | null> {
  const apps = await listAll<AccessApp>(creds, "/access/apps");
  return apps.find((app) => app.domain === domain) ?? null;
}

export async function createAccessApp(
  creds: CloudflareCreds,
  app: { name: string; domain: string; policyId: string; idpId: string }
): Promise<AccessApp> {
  return request<AccessApp>(creds.apiToken, `${account(creds)}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: app.name,
      domain: app.domain,
      type: "self_hosted",
      allowed_idps: [app.idpId],
      auto_redirect_to_identity: true,
      policies: [{ id: app.policyId, precedence: 1 }],
    }),
  });
}
