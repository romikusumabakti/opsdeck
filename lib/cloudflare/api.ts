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

/**
 * The fetched tunnel config is not one the Panel may edit: no ingress list, an
 * empty one, or no catch-all last. Writing it back would drop live routes.
 */
export class UnsafeTunnelConfigError extends Error {}

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

/** The config as Cloudflare returned it, before withIngressRoute checks it. */
export type FetchedTunnelConfig = {
  ingress?: unknown;
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

/**
 * The tunnel's remote config exactly as Cloudflare holds it; `{}` when it has
 * none. Never filled in: an invented empty ingress written back would wipe
 * every live route, so withIngressRoute checks the shape instead.
 */
export async function getTunnelConfig(
  creds: CloudflareCreds,
  tunnelId: string
): Promise<FetchedTunnelConfig> {
  const result = await request<{ config?: FetchedTunnelConfig | null }>(
    creds.apiToken,
    configPath(creds, tunnelId)
  );
  return result.config ?? {};
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

// DNS names are case-insensitive; Cloudflare may echo them in any case.
function sameHostname(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function isCatchAll(rule: IngressRule): boolean {
  return rule.hostname === undefined;
}

function isWildcard(rule: IngressRule): boolean {
  return rule.hostname?.startsWith("*") === true;
}

/**
 * The config as an editable TunnelConfig, or UnsafeTunnelConfigError when it
 * has no ingress list, an empty one, or a last rule with a hostname (cloudflared
 * requires a catch-all last, so a live config always has one).
 */
function editableConfig(config: FetchedTunnelConfig): TunnelConfig {
  const { ingress } = config;
  if (!Array.isArray(ingress) || ingress.length === 0) {
    throw new UnsafeTunnelConfigError(
      "Tunnel config has no ingress rules; refusing to overwrite it"
    );
  }
  const rules = ingress as IngressRule[];
  const last = rules.at(-1);
  if (!last || typeof last !== "object" || !isCatchAll(last)) {
    throw new UnsafeTunnelConfigError(
      "Tunnel config has no catch-all ingress rule; refusing to overwrite it"
    );
  }
  return { ...config, ingress: rules };
}

/**
 * The config with an ingress rule `hostname` -> `service`, without mutating
 * `config`. Cloudflare matches rules top-down, so the rule goes before the
 * first wildcard rule (`*.example.com`) if there is one, else just before the
 * catch-all. Everything else is preserved. A config without a non-empty
 * ingress ending in a catch-all is refused (UnsafeTunnelConfigError), and a
 * hostname that already routes to another service is a conflict, never an
 * overwrite.
 */
export function withIngressRoute(
  fetched: FetchedTunnelConfig,
  hostname: string,
  service: string
): { config: TunnelConfig; changed: boolean } {
  const config = editableConfig(fetched);
  const existing = config.ingress.find((rule) =>
    sameHostname(rule.hostname, hostname)
  );
  if (existing) {
    if (existing.service === service) return { config, changed: false };
    throw new CloudflareConflictError(
      `${hostname} already routes to ${existing.service}`
    );
  }
  const next = structuredClone(config);
  const wildcardAt = next.ingress.findIndex(isWildcard);
  const at = wildcardAt === -1 ? next.ingress.length - 1 : wildcardAt;
  next.ingress.splice(at, 0, { hostname, service });
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
  // The filter is exact on Cloudflare's side; the check keeps it so here.
  return records.find((record) => sameHostname(record.name, name)) ?? null;
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

export type AccessPolicy = {
  id: string;
  name: string;
  /** allow, deny, non_identity or bypass. */
  decision: string;
  /** Whether an include rule is `everyone`. */
  everyone: boolean;
};

/** Reusable Access policies of the account. */
export async function listAccessPolicies(
  creds: CloudflareCreds
): Promise<AccessPolicy[]> {
  const policies = await listAll<{
    id: string;
    name: string;
    decision?: string;
    include?: Record<string, unknown>[];
  }>(creds, "/access/policies");
  return policies.map((p) => ({
    id: p.id,
    name: p.name,
    decision: p.decision ?? "",
    everyone: (p.include ?? []).some((rule) => "everyone" in rule),
  }));
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
  /** Every domain of a multi-domain self-hosted app (older API shape). */
  self_hosted_domains?: string[];
  /** The app's destinations; `public` ones carry a `uri` (newer API shape). */
  destinations?: { type: string; uri?: string }[];
  policies?: { id: string }[];
};

function appDomains(app: AccessApp): string[] {
  return [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? [])
      .filter((d) => d.type === "public" && d.uri)
      .map((d) => d.uri as string),
  ];
}

/**
 * The Access app that covers exactly `domain` (no path), through its
 * `domain`, its `self_hosted_domains` or a public destination; or null.
 * Compared case-insensitively.
 */
export async function findAccessAppByDomain(
  creds: CloudflareCreds,
  domain: string
): Promise<AccessApp | null> {
  const apps = await listAll<AccessApp>(creds, "/access/apps");
  return (
    apps.find((app) =>
      appDomains(app).some((candidate) => sameHostname(candidate, domain))
    ) ?? null
  );
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
