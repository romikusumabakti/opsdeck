// @vitest-environment happy-dom
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
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
