// Which release this instance can update to, from GitHub Releases. The API is
// called without credentials (60 requests an hour per IP), so the result is
// cached for an hour and a refusal (403 rate limit) keeps the last one known.
import { z } from "zod";
import { compareVersions, parseVersion } from "@/lib/version";
import { RELEASE_VERSION_RE } from "./request";

export const RELEASES_API =
  "https://api.github.com/repos/romikusumabakti/opsdeck/releases";
/** Where update.sh downloads release.json from too. */
export const RELEASE_DOWNLOAD_BASE =
  "https://github.com/romikusumabakti/opsdeck/releases/download";
export const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;

export type UpdateChannel = "stable" | "beta";

export type AvailableRelease = {
  version: string;
  notesUrl: string;
  /** The oldest version that can update to it directly. */
  minFrom: string;
};

export class ReleaseCheckError extends Error {
  readonly code = "updateCheckFailed";
  constructor(detail: string) {
    super(`updateCheckFailed: ${detail}`);
    this.name = "ReleaseCheckError";
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const releaseListSchema = z.array(
  z.object({
    tag_name: z.string(),
    prerelease: z.boolean(),
    draft: z.boolean(),
    html_url: z.url(),
  })
);

const releaseJsonSchema = z.object({
  version: z.string(),
  minFrom: z.string().regex(RELEASE_VERSION_RE),
});

const TIMEOUT_MS = 15_000;

async function get(fetchImpl: Fetch, url: string, init: RequestInit = {}) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ReleaseCheckError(`${url}: ${(error as Error).message}`);
  }
}

/**
 * The newest release newer than `current` on the channel, or null. `stable`
 * ignores prereleases; `beta` takes the newest of all (a newer stable
 * included). A release without a usable release.json (still uploading) is
 * skipped. A build that is not a release (`0.0.0-dev`) is never offered one.
 */
export async function latestRelease(
  channel: UpdateChannel,
  current: string,
  fetchImpl: Fetch = fetch
): Promise<AvailableRelease | null> {
  if (!RELEASE_VERSION_RE.test(current) || !parseVersion(current)) return null;
  const res = await get(fetchImpl, `${RELEASES_API}?per_page=50`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opsdeck-update-check",
    },
  });
  if (!res.ok) {
    const limited =
      (res.status === 403 || res.status === 429) &&
      res.headers.get("x-ratelimit-remaining") === "0";
    throw new ReleaseCheckError(
      limited ? "GitHub API rate limit" : `GitHub API HTTP ${res.status}`
    );
  }
  const parsed = releaseListSchema.safeParse(
    await res.json().catch(() => null)
  );
  if (!parsed.success) throw new ReleaseCheckError("unexpected release list");

  const candidates = parsed.data
    .filter((r) => !r.draft && r.tag_name.startsWith("v"))
    .map((r) => ({ ...r, version: r.tag_name.slice(1) }))
    .filter((r) => RELEASE_VERSION_RE.test(r.version))
    .filter((r) => channel === "beta" || !r.prerelease)
    .filter((r) => channel === "beta" || parseVersion(r.version)?.beta == null)
    .filter((r) => compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));

  for (const release of candidates) {
    const file = await get(
      fetchImpl,
      `${RELEASE_DOWNLOAD_BASE}/v${release.version}/release.json`
    );
    if (file.status === 404) continue;
    if (!file.ok) {
      throw new ReleaseCheckError(`release.json HTTP ${file.status}`);
    }
    const manifest = releaseJsonSchema.safeParse(
      await file.json().catch(() => null)
    );
    if (!manifest.success || manifest.data.version !== release.version) {
      throw new ReleaseCheckError(
        `release.json of v${release.version} is invalid`
      );
    }
    return {
      version: release.version,
      notesUrl: release.html_url,
      minFrom: manifest.data.minFrom,
    };
  }
  return null;
}

export type UpdateCheck = {
  available: AvailableRelease | null;
  /** `updateCheckFailed` when the last attempt failed (`available` is the last known). */
  error: "updateCheckFailed" | null;
  /** When `available` was last read from GitHub; null when never. */
  checkedAt: Date | null;
};

type Cached = {
  key: string;
  available: AvailableRelease | null;
  checkedAt: Date | null;
  /** The last attempt, successful or not. */
  attemptedAt: Date;
  error: UpdateCheck["error"];
};

// The app is one process (server and worker), so a module cache serves both
// the Updates tab and the hourly job.
let cached: Cached | null = null;
let inFlight: Promise<UpdateCheck> | null = null;

export function resetUpdateCheckCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * The cached check for this channel and version, refreshed when older than
 * an hour (or `force`). A failed refresh keeps the last known result and
 * reports `updateCheckFailed`; it is retried after the hour too, so a rate
 * limit is not hammered.
 */
export async function checkForUpdate(
  channel: UpdateChannel,
  current: string,
  opts: { force?: boolean; now?: Date; fetch?: Fetch } = {}
): Promise<UpdateCheck> {
  const now = opts.now ?? new Date();
  const key = `${channel}:${current}`;
  const usable = cached?.key === key ? cached : null;
  if (
    usable &&
    !opts.force &&
    now.getTime() - usable.attemptedAt.getTime() < UPDATE_CHECK_TTL_MS
  ) {
    return view(usable);
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const available = await latestRelease(channel, current, opts.fetch);
      cached = {
        key,
        available,
        checkedAt: now,
        attemptedAt: now,
        error: null,
      };
    } catch (error) {
      if (!(error instanceof ReleaseCheckError)) throw error;
      const last = cached?.key === key ? cached : null;
      cached = {
        key,
        available: last?.available ?? null,
        checkedAt: last?.checkedAt ?? null,
        attemptedAt: now,
        error: error.code,
      };
    }
    return view(cached);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function view(c: Cached): UpdateCheck {
  return {
    available: c.available,
    error: c.error,
    checkedAt: c.checkedAt,
  };
}
