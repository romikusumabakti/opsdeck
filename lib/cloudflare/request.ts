// The one Cloudflare REST request helper, shared by the zone-scoped DNS client
// (lib/tunnels/cloudflare.ts) and the account-scoped client (lib/cloudflare/api.ts).
// Deliberately not the Cloudflare SDK: the surface is a handful of endpoints,
// and a dependency that can reach every Cloudflare product is a poor match for
// a credential scoped to a few permissions.

export const API_BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare's API is fronted by its own edge; 10s is generous for a write and
// keeps a hung call from holding a server action open.
const REQUEST_TIMEOUT_MS = 10_000;

export class CloudflareApiError extends Error {
  /** The HTTP status when Cloudflare answered; unset for network failures. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type ResultInfo = {
  page?: number;
  per_page?: number;
  total_pages?: number;
  total_count?: number;
};

type ApiEnvelope<T> = {
  success: boolean;
  errors: { code?: number; message?: string }[];
  result: T;
  result_info?: ResultInfo;
};

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

/** Like `request`, but also returns the envelope's `result_info`. */
export async function requestWithInfo<T>(
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<{ result: T; info: ResultInfo }> {
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
      `Cloudflare API returned ${response.status} with a non-JSON body`,
      response.status
    );
  }

  if (!response.ok || !body.success) {
    throw new CloudflareApiError(
      describeCloudflareErrors(body.errors ?? []),
      response.status
    );
  }
  return { result: body.result, info: body.result_info ?? {} };
}

export async function request<T>(
  apiToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  return (await requestWithInfo<T>(apiToken, path, init)).result;
}
