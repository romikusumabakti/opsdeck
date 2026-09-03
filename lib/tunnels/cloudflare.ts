import "server-only";

// Minimal Cloudflare REST client — the three DNS-record calls this feature
// needs, plus a token check.
//
// This is deliberately not the Cloudflare SDK: the whole surface is three
// endpoints, and a dependency that can reach every Cloudflare product is a
// poor match for a credential scoped to `Zone:DNS:Edit` on one zone.
//
// Creating the CNAME through the API is what lets the panel avoid `cert.pem`
// entirely. `cloudflared tunnel route dns` does exactly what createCnameRecord
// does below, but it authenticates with the account-wide origin certificate —
// a credential that can publish a hostname anywhere in the zone and which the
// operator's runbook deliberately shreds after every use. A scoped API token
// is the smaller thing to keep.

const API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare's API is fronted by its own edge; 10s is generous for a DNS write
// and keeps a hung call from holding a server action open.
const REQUEST_TIMEOUT_MS = 10_000;

export class CloudflareApiError extends Error {}

export type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
};

type ApiEnvelope<T> = {
  success: boolean;
  errors: { code?: number; message?: string }[];
  result: T;
};

/**
 * The CNAME target that routes a hostname into a tunnel. Cloudflare resolves
 * `<tunnel-id>.cfargotunnel.com` internally — it has no public A record, which
 * is why the record must be proxied to work at all.
 */
export function cnameTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

/**
 * Flatten Cloudflare's error array into one line.
 *
 * Exported for tests: the failures that matter operationally (10000 invalid
 * token, 81053 record exists) are distinguished only by this text, so it has
 * to stay readable rather than collapse to "request failed".
 */
export function describeCloudflareErrors(
  errors: { code?: number; message?: string }[]
): string {
  if (errors.length === 0)
    return "Cloudflare returned an unsuccessful response";
  return errors
    .map((e) =>
      e.code ? `${e.message ?? "error"} (code ${e.code})` : e.message
    )
    .filter(Boolean)
    .join("; ");
}

async function request<T>(
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure or timeout: there is no envelope to read, and the token
    // must not end up in the message.
    throw new CloudflareApiError(
      `Could not reach the Cloudflare API: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new CloudflareApiError(
      `Cloudflare API returned ${response.status} with a non-JSON body`
    );
  }

  if (!response.ok || !body.success) {
    throw new CloudflareApiError(describeCloudflareErrors(body.errors ?? []));
  }
  return body.result;
}

/**
 * Confirm the token works and carries the permissions this feature needs, by
 * listing one record from the zone it is scoped to. Backs the "Test" button on
 * the zone form: a token pasted with a typo, or scoped to the wrong zone, is
 * far better caught here than halfway through publishing a hostname.
 */
export async function verifyZoneAccess(zone: {
  zoneId: string;
  apiToken: string;
}): Promise<void> {
  await request<DnsRecord[]>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records?per_page=1`
  );
}

/** The DNS record for `name`, or null when the name is free. */
export async function findDnsRecord(
  zone: { zoneId: string; apiToken: string },
  name: string
): Promise<DnsRecord | null> {
  const records = await request<DnsRecord[]>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records?name=${encodeURIComponent(name)}`
  );
  return records[0] ?? null;
}

/**
 * Create the proxied CNAME that points `name` at `tunnelId`.
 *
 * `proxied: true` is not a preference. An unproxied record would hand out
 * `<id>.cfargotunnel.com` to the public resolver, which resolves to nothing:
 * the tunnel is only reachable from inside Cloudflare's edge.
 */
export async function createCnameRecord(
  zone: { zoneId: string; apiToken: string },
  options: { name: string; tunnelId: string; comment?: string }
): Promise<DnsRecord> {
  return request<DnsRecord>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: options.name,
        content: cnameTarget(options.tunnelId),
        proxied: true,
        // 1 = "automatic". Proxied records are served from the edge, so the
        // origin TTL is not what clients observe anyway.
        ttl: 1,
        comment: options.comment,
      }),
    }
  );
}

export async function deleteDnsRecord(
  zone: { zoneId: string; apiToken: string },
  recordId: string
): Promise<void> {
  await request<{ id: string }>(
    zone.apiToken,
    `/zones/${encodeURIComponent(zone.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    { method: "DELETE" }
  );
}

export type DnsCheck =
  | { state: "ok"; record: DnsRecord }
  | { state: "missing" }
  | { state: "mismatch"; record: DnsRecord }
  | { state: "error"; message: string };

/**
 * Classify the DNS side of one hostname for the ingress table.
 *
 * `mismatch` is the case worth surfacing loudly: a record that exists but does
 * not point at this tunnel means traffic for a hostname listed in this config
 * is going somewhere else entirely.
 */
export async function checkDnsRecord(
  zone: { zoneId: string; apiToken: string },
  options: { name: string; tunnelId: string }
): Promise<DnsCheck> {
  try {
    const record = await findDnsRecord(zone, options.name);
    if (!record) return { state: "missing" };
    if (
      record.type !== "CNAME" ||
      record.content !== cnameTarget(options.tunnelId)
    ) {
      return { state: "mismatch", record };
    }
    return { state: "ok", record };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
