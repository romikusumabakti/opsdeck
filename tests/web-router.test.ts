// @vitest-environment happy-dom
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { bootstrapQuery, meQuery } from "@/web/api/session";
import { createQueryClient } from "@/web/query-client";
import { routeTree } from "@/web/routeTree.gen";
import { parseSearch, stringifySearch } from "@/web/search-params";

const bootstrap = {
  appName: "Panel",
  companyName: "Acme",
  allowedEmailDomain: "acme.test",
  brand: "default",
  microsoftSignIn: false,
  appTimeZone: "Asia/Jakarta",
};

// The route tree's own redirects and gates, loaded headless with the session
// answers already in the cache (no fetch).
async function load(url: string, me: unknown) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(meQuery().queryKey, me as never);
  queryClient.setQueryData(bootstrapQuery().queryKey, bootstrap as never);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [url] }),
    parseSearch,
    stringifySearch,
  });
  await router.load();
  return router;
}

const signedIn = { user: { id: "u1" }, orgRole: "member", timeZone: "UTC" };

describe("web route tree", () => {
  it("adds the default locale to a bare path", async () => {
    const router = await load("/servers?tab=usage", signedIn);
    expect(router.state.location.pathname).toBe("/en/servers");
    expect(router.state.location.searchStr).toBe("?tab=usage");
  });

  it("sends a signed-out deep link to sign-in, keeping the locale", async () => {
    const router = await load("/id/servers/abc", null);
    expect(router.state.location.pathname).toBe("/id/sign-in");
    expect(router.state.location.search).toEqual({
      redirect: "/servers/abc",
    });
  });

  // The session dies while the tab is open: the next navigation must reach
  // sign-in, not pass the gate on the cached user.
  it("gates again once a 401 has cleared the cached user", async () => {
    const router = await load("/id/servers", signedIn);
    expect(router.state.location.pathname).toBe("/id/servers");
    const { queryClient } = router.options.context as {
      queryClient: ReturnType<typeof createQueryClient>;
    };
    queryClient.setQueryData(meQuery().queryKey, null);
    await router.navigate({ href: "/id/servers/abc" });
    expect(router.state.location.pathname).toBe("/id/sign-in");
    expect(router.state.location.search).toEqual({
      redirect: "/servers/abc",
    });
  });

  it("drops an unsafe redirect target on sign-in", async () => {
    const router = await load("/en/sign-in?redirect=%2F%2Fevil.example", null);
    const signIn = router.state.matches.find(
      (m) => m.routeId === "/$locale/sign-in"
    );
    expect(signIn?.search).toEqual({ redirect: undefined });
  });

  it("drops a redirect target that is itself a signed-out page", async () => {
    for (const target of ["/sign-in", "/setup?x=1", "/sign-in/"]) {
      const router = await load(
        `/en/sign-in?redirect=${encodeURIComponent(target)}`,
        null
      );
      const signIn = router.state.matches.find(
        (m) => m.routeId === "/$locale/sign-in"
      );
      expect(signIn?.search.redirect).toBeUndefined();
    }
  });

  // Without the rule above this took a second hop through sign-in.
  it("sends a signed-in visitor of sign-in?redirect=/sign-in home", async () => {
    const router = await load("/id/sign-in?redirect=%2Fsign-in", signedIn);
    expect(router.state.location.pathname).toBe("/id");
  });

  // The Tasks 8–11 convention: a page's `throw notFound()` is caught by the
  // `_app` route (it re-renders the shell around the 404), not by $locale,
  // which would replace the shell. The splat route throws exactly that way.
  it("catches a page's notFound in the app shell", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("count")) return Response.json(0);
        if (url.includes("assigned-issue-counts")) {
          return Response.json({ total: 0, byProject: {} });
        }
        if (url.includes("my-access")) {
          return Response.json({ all: true, roles: {} });
        }
        return Response.json([]);
      })
    );
    try {
      const router = await load("/en/no-such-page", signedIn);
      const statuses = Object.fromEntries(
        router.state.matches.map((m) => [m.routeId, m.status])
      );
      expect(statuses["/$locale"]).toBe("success");
      expect(statuses["/$locale/_app"]).toBe("notFound");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("brands the locale's messages", async () => {
    const router = await load("/en/sign-in", null);
    const match = router.state.matches.find((m) => m.routeId === "/$locale");
    const messages = match?.loaderData?.messages as Record<string, unknown>;
    expect(JSON.stringify(messages)).not.toContain("{{APP_NAME}}");
  });

  // An unknown first segment is not a locale: the path gets the default one,
  // then the project-key casing — so the $locale route never sees "xx".
  it("treats an unknown locale segment as a path", async () => {
    const router = await load("/xx/servers", signedIn);
    expect(router.state.location.pathname).toBe("/en/XX/servers");
  });
});
