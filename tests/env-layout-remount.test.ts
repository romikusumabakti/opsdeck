import { describe, expect, it } from "vitest";
import { Route } from "@/web/routes/$locale/_app/$projectKey.$envSlug.route";

// Switching environments from the breadcrumb keeps the same route matched with
// new params; without a remount, pages keep the previous environment's form
// state (useForm captures its defaults once).
describe("environment layout remount", () => {
  const deps = (projectKey: string, envSlug: string, search = {}) =>
    JSON.stringify(
      (Route.options.remountDeps as (opts: unknown) => unknown)({
        params: { locale: "en", projectKey, envSlug },
        search,
        loaderDeps: {},
        routeId: Route.id,
      })
    );

  it("remounts when the environment changes", () => {
    expect(deps("CRMB", "fee-daily")).not.toBe(deps("CRMB", "p2sk"));
  });

  it("remounts when the project changes", () => {
    expect(deps("CRMB", "dev")).not.toBe(deps("TMMB", "dev"));
  });

  it("keeps the page mounted when only the search changes", () => {
    expect(deps("CRMB", "p2sk")).toBe(
      deps("CRMB", "p2sk", { tab: "source-deploy" })
    );
  });
});
