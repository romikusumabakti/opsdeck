import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  latestRelease,
  RELEASES_API,
  ReleaseCheckError,
  resetUpdateCheckCache,
} from "@/lib/updates/releases";

const BASE = "https://github.com/romikusumabakti/opsdeck/releases/download";

// GitHub's list (newest first), trimmed to the fields the check reads.
const RELEASES = [
  {
    tag_name: "v1.3.0-beta.1",
    prerelease: true,
    draft: false,
    html_url:
      "https://github.com/romikusumabakti/opsdeck/releases/tag/v1.3.0-beta.1",
  },
  {
    tag_name: "v1.2.1",
    prerelease: false,
    draft: false,
    html_url: "https://github.com/romikusumabakti/opsdeck/releases/tag/v1.2.1",
  },
  {
    tag_name: "v1.2.0",
    prerelease: false,
    draft: false,
    html_url: "https://github.com/romikusumabakti/opsdeck/releases/tag/v1.2.0",
  },
];

function releaseJson(version: string, minFrom = "1.0.0") {
  return { version, minFrom, images: {}, notesUrl: "x" };
}

type Route = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body ?? null), {
      status: route.status,
      headers: route.headers,
    });
  });
}

const listUrl = `${RELEASES_API}?per_page=50`;

function defaultRoutes(): Record<string, Route> {
  return {
    [listUrl]: { status: 200, body: RELEASES },
    [`${BASE}/v1.3.0-beta.1/release.json`]: {
      status: 200,
      body: releaseJson("1.3.0-beta.1", "1.1.0"),
    },
    [`${BASE}/v1.2.1/release.json`]: {
      status: 200,
      body: releaseJson("1.2.1", "1.0.0"),
    },
    [`${BASE}/v1.2.0/release.json`]: {
      status: 200,
      body: releaseJson("1.2.0"),
    },
  };
}

describe("latestRelease", () => {
  it("stable skips the prerelease and returns the newest stable", async () => {
    const fetch = fakeFetch(defaultRoutes());
    await expect(latestRelease("stable", "1.2.0", fetch)).resolves.toEqual({
      version: "1.2.1",
      notesUrl: RELEASES[1]?.html_url,
      minFrom: "1.0.0",
    });
  });

  it("beta returns the newest of all", async () => {
    const fetch = fakeFetch(defaultRoutes());
    await expect(latestRelease("beta", "1.2.0", fetch)).resolves.toEqual({
      version: "1.3.0-beta.1",
      notesUrl: RELEASES[0]?.html_url,
      minFrom: "1.1.0",
    });
  });

  it("returns null when the current version is the newest", async () => {
    const fetch = fakeFetch(defaultRoutes());
    await expect(latestRelease("stable", "1.2.1", fetch)).resolves.toBeNull();
    await expect(
      latestRelease("beta", "1.3.0-beta.1", fetch)
    ).resolves.toBeNull();
  });

  it("returns null for a build that is not a release (dev)", async () => {
    const fetch = fakeFetch(defaultRoutes());
    await expect(
      latestRelease("stable", "0.0.0-dev", fetch)
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips drafts, odd tags and a release without release.json", async () => {
    const routes = defaultRoutes();
    routes[listUrl] = {
      status: 200,
      body: [
        { ...RELEASES[1], tag_name: "v9.9.9", draft: true },
        { ...RELEASES[1], tag_name: "nightly" },
        { ...RELEASES[1], tag_name: "v1.2.2" }, // no release.json (404)
        ...RELEASES,
      ],
    };
    const fetch = fakeFetch(routes);
    await expect(
      latestRelease("stable", "1.2.0", fetch)
    ).resolves.toMatchObject({ version: "1.2.1" });
  });

  it("skips a candidate whose release.json is malformed or for another version", async () => {
    for (const bad of [releaseJson("1.2.0"), { version: "1.2.1" }, "garbage"]) {
      const routes = defaultRoutes();
      routes[`${BASE}/v1.2.1/release.json`] = { status: 200, body: bad };
      await expect(
        latestRelease("stable", "1.1.0", fakeFetch(routes))
      ).resolves.toMatchObject({ version: "1.2.0" });
    }
  });

  it("throws updateCheckFailed on the unauthenticated rate limit (403)", async () => {
    const fetch = fakeFetch({
      [listUrl]: {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const error = await latestRelease("stable", "1.2.0", fetch).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ReleaseCheckError);
    expect((error as ReleaseCheckError).code).toBe("updateCheckFailed");
  });

  it("asks GitHub's REST API for JSON without credentials", async () => {
    const fetch = fakeFetch(defaultRoutes());
    await latestRelease("stable", "1.2.0", fetch);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(listUrl);
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("authorization")).toBeNull();
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => resetUpdateCheckCache());
  const t0 = new Date("2026-11-09T10:00:00Z");
  const later = (ms: number) => new Date(t0.getTime() + ms);

  it("caches the result for an hour per channel and version", async () => {
    const fetch = fakeFetch(defaultRoutes());
    const first = await checkForUpdate("stable", "1.2.0", { fetch, now: t0 });
    expect(first).toMatchObject({
      available: { version: "1.2.1" },
      error: null,
      checkedAt: t0,
    });
    const calls = fetch.mock.calls.length;
    await checkForUpdate("stable", "1.2.0", { fetch, now: later(30 * 60e3) });
    expect(fetch.mock.calls.length).toBe(calls);
    await checkForUpdate("beta", "1.2.0", { fetch, now: later(30 * 60e3) });
    expect(fetch.mock.calls.length).toBeGreaterThan(calls);
  });

  it("keeps the last known result when GitHub refuses (403)", async () => {
    const ok = fakeFetch(defaultRoutes());
    await checkForUpdate("stable", "1.2.0", { fetch: ok, now: t0 });
    const limited = fakeFetch({
      [listUrl]: { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    });
    const result = await checkForUpdate("stable", "1.2.0", {
      fetch: limited,
      now: later(2 * 3600e3),
      force: true,
    });
    expect(result).toEqual({
      available: {
        version: "1.2.1",
        notesUrl: RELEASES[1]?.html_url,
        minFrom: "1.0.0",
      },
      error: "updateCheckFailed",
      checkedAt: t0,
    });
  });

  it("reports updateCheckFailed with nothing known yet", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      checkForUpdate("stable", "1.2.0", { fetch: down, now: t0 })
    ).resolves.toEqual({
      available: null,
      error: "updateCheckFailed",
      checkedAt: null,
    });
  });
});
