// @vitest-environment happy-dom
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { RESERVED_ENV_SLUGS } from "../lib/reserved-paths";
import { Route as Variables } from "../web/routes/$locale/_app/$projectKey.$envSlug.variables";
import { Route as Overview } from "../web/routes/$locale/_app/$projectKey.index";
import { Route as Milestones } from "../web/routes/$locale/_app/$projectKey.milestones";

/** The href a route's beforeLoad or loader redirects to. */
async function redirectOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isRedirect(error)) return String(error.options.href);
    throw error;
  }
  throw new Error("no redirect");
}

type Loader = (ctx: unknown) => unknown;

describe("removed Milestones page", () => {
  it("/KEY/milestones redirects to the project overview", async () => {
    const href = await redirectOf(() =>
      (Milestones.options.beforeLoad as Loader)({
        params: { locale: "en", projectKey: "CRMB" },
      })
    );
    expect(href).toMatch(/\/CRMB$/);
  });
  it("?tab=milestones stays on the overview", () => {
    expect(
      (Overview.options.validateSearch as (s: object) => { tab?: string })({
        tab: "milestones",
      }).tab
    ).toBeUndefined();
  });
  it("milestones stays a reserved environment slug", () => {
    expect(RESERVED_ENV_SLUGS.has("milestones")).toBe(true);
  });
});

describe("moved Variables page", () => {
  const variablesHref = (searchStr: string) =>
    redirectOf(() =>
      (Variables.options.beforeLoad as Loader)({
        params: { locale: "en", projectKey: "KMEM", envSlug: "dev-1" },
        location: { searchStr },
      })
    );
  it("/KEY/env/variables opens the Variables settings tab", async () => {
    expect(await variablesHref("")).toMatch(
      /\/KMEM\/dev-1\/settings\?tab=variables$/
    );
  });
  it("carries the bookmark's search params and overrides a stray tab", async () => {
    const url = new URL(await variablesHref("?q=DB&tab=general"), "http://x");
    expect(url.pathname).toMatch(/\/KMEM\/dev-1\/settings$/);
    expect(url.searchParams.get("q")).toBe("DB");
    expect(url.searchParams.getAll("tab")).toEqual(["variables"]);
  });
});
