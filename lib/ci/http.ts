import { CiProviderError } from "@/lib/ci/types";

/** Every CI provider and forge call gives up after this long. */
export const CI_FETCH_TIMEOUT_MS = 15_000;

/**
 * One outbound call to a CI provider or forge. Redirects are not followed (a
 * 3xx usually means a login page such as Cloudflare Access, and following it
 * would send the credentials along), and the call times out. Failures become a
 * CiProviderError whose message is built from `label` only: the underlying
 * error is dropped on purpose because it could echo the request. Non-2xx
 * responses other than redirects are returned for the caller to report.
 */
export async function ciFetch(
  label: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(CI_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new CiProviderError(`${label} timed out`, 0);
    }
    throw new CiProviderError(`${label} unreachable`, 0);
  }
  if (
    res.type === "opaqueredirect" ||
    (res.status >= 300 && res.status < 400)
  ) {
    throw new CiProviderError(
      `${label} redirected — check the URL/Access`,
      res.status
    );
  }
  return res;
}
