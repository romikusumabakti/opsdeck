// @vitest-environment happy-dom
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvironmentPath } from "@/lib/canonical-path";
import { bootstrapQuery, meQuery } from "@/web/api/session";
import { createQueryClient } from "@/web/query-client";
import { routeTree } from "@/web/routeTree.gen";
import { parseSearch, stringifySearch } from "@/web/search-params";

// A link built before a rename (a notification, a bookmark, an assistant
// answer) names the environment by an old slug, or by the project it has
// left: the environment route replaces it with the current one, keeping the
// rest of the path, the query and the hash, before any page renders.

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const bootstrap = {
  appName: "Menara",
  companyName: "Acme",
  allowedEmailDomain: "acme.test",
  accent: "neutral",
  logo: null,
  icon: { src: "/brand/icon.svg", type: "image/svg+xml", custom: false },
  microsoftSignIn: false,
  appTimeZone: "Asia/Jakarta",
};
const signedIn = { user: { id: "u1" }, orgRole: "engineer", timeZone: "UTC" };

// What /api/environments/resolve answers per `KEY/slug`: `qa` was renamed
// `qa-1`; `OLD/stage` moved to HMEM as `stage`.
const CANONICAL: Record<string, { projectKey: string; envSlug: string }> = {
  "HMEM/qa": { projectKey: "HMEM", envSlug: "qa-1" },
  "HMEM/qa-1": { projectKey: "HMEM", envSlug: "qa-1" },
  "OLD/stage": { projectKey: "HMEM", envSlug: "stage" },
  "HMEM/stage": { projectKey: "HMEM", envSlug: "stage" },
};

const resolveCalls: string[] = [];

beforeEach(() => {
  resolveCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        String(input instanceof Request ? input.url : input),
        "http://panel.test"
      );
      if (url.pathname.endsWith("/environments/resolve")) {
        const key = `${url.searchParams.get("projectKey")}/${url.searchParams.get("envSlug")}`;
        resolveCalls.push(key);
        const canonical = CANONICAL[key];
        if (!canonical) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({
          environmentId: ENV_ID,
          role: "engineer",
          ...canonical,
        });
      }
      if (url.pathname.includes("count")) return Response.json(0);
      if (url.pathname.includes("assigned-issue-counts")) {
        return Response.json({ total: 0, byProject: {} });
      }
      if (url.pathname.includes("my-access")) {
        return Response.json({ all: true, roles: {} });
      }
      return Response.json([]);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRouter(url: string) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(meQuery().queryKey, signedIn as never);
  queryClient.setQueryData(bootstrapQuery().queryKey, bootstrap as never);
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history,
    parseSearch,
    stringifySearch,
  });
  // Every location a navigation settled on, to prove the old one never did.
  const resolved: string[] = [];
  router.subscribe("onResolved", (event) => {
    resolved.push(event.toLocation.pathname);
  });
  return { router, history, resolved };
}

// The env route's notFound renders in the app shell's boundary (`_app`).
const notFoundShown = (router: ReturnType<typeof makeRouter>["router"]) =>
  router.state.matches.some((m) => m.status === "notFound");

describe("withEnvironmentPath", () => {
  it("swaps the key and slug and keeps the rest", () => {
    expect(withEnvironmentPath("/en/HMEM/qa/deploys", "HMEM", "qa-1")).toBe(
      "/en/HMEM/qa-1/deploys"
    );
    expect(
      withEnvironmentPath("/ar/OLD/stage/services/db/logs", "HMEM", "stage")
    ).toBe("/ar/HMEM/stage/services/db/logs");
    expect(withEnvironmentPath("/id/HMEM/qa", "HMEM", "qa-1")).toBe(
      "/id/HMEM/qa-1"
    );
  });
});

describe("an environment link with an old slug", () => {
  // Review Focus 1.
  it("lands on the current slug with the rest path, query and hash, replacing history", async () => {
    const { router, history, resolved } = makeRouter("/en/HMEM");
    await router.load();
    await router.navigate({ href: "/en/HMEM/qa/deploys?tab=x#y" });

    expect(router.state.location.pathname).toBe("/en/HMEM/qa-1/deploys");
    expect(router.state.location.searchStr).toBe("?tab=x");
    expect(router.state.location.hash).toBe("y");
    // The old URL was replaced, not kept as a second entry: Back goes to
    // the page before the link.
    expect(history.length).toBe(2);
    expect(resolved).not.toContain("/en/HMEM/qa/deploys");
    expect(notFoundShown(router)).toBe(false);
  });

  // Review Focus 4: a notification's href (lib/notifications: /KEY/slug/history).
  it("opens a notification link built before the rename", async () => {
    const { router, resolved } = makeRouter("/en/HMEM/qa/history");
    await router.load();
    expect(router.state.location.pathname).toBe("/en/HMEM/qa-1/history");
    expect(resolved).toEqual(["/en/HMEM/qa-1/history"]);
    expect(notFoundShown(router)).toBe(false);
  });

  it("follows an environment that moved to another project", async () => {
    const { router } = makeRouter("/en/OLD/stage/settings?tab=general");
    await router.load();
    expect(router.state.location.pathname).toBe("/en/HMEM/stage/settings");
    expect(router.state.location.searchStr).toBe("?tab=general");
  });

  it("stays on a current slug without a second resolve", async () => {
    const { router } = makeRouter("/en/HMEM/qa-1/history");
    await router.load();
    expect(router.state.location.pathname).toBe("/en/HMEM/qa-1/history");
    expect(resolveCalls).toEqual(["HMEM/qa-1"]);
  });

  it("an unknown slug is still the not-found page", async () => {
    const { router } = makeRouter("/en/HMEM/nope/history");
    await router.load();
    expect(router.state.location.pathname).toBe("/en/HMEM/nope/history");
    expect(notFoundShown(router)).toBe(true);
  });
});
