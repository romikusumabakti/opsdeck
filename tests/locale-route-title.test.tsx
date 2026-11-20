import { describe, expect, it } from "vitest";

// The browser tab title is the instance name as the admin typed it, not the
// ICU-escaped catalogue string applyBranding produces for use-intl.

const { Route } = await import("../web/routes/$locale/route");

type Loader = (ctx: unknown) => Promise<unknown>;
type Head = (ctx: { loaderData: unknown }) => {
  meta?: { title?: string }[];
};

describe("the locale route's document title", () => {
  for (const appName of ["Romi's Deck", "Ops {x} 'y' #1 <b>", "a}b"]) {
    it(`is the plain instance name for ${JSON.stringify(appName)}`, async () => {
      const bootstrap = {
        appName,
        companyName: null,
        allowedEmailDomain: "example.com",
      };
      const loaderData = await (Route.options.loader as unknown as Loader)({
        params: { locale: "en" },
        context: { queryClient: { query: async () => bootstrap } },
      });
      const head = (Route.options.head as unknown as Head)({ loaderData });
      expect(head.meta?.[0]?.title).toBe(appName);
    });
  }
});
