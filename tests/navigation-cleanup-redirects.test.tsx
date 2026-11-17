// @vitest-environment happy-dom
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { parseNavPath } from "../lib/nav-path";
import { RESERVED_ENV_SLUGS } from "../lib/reserved-paths";
import { Route as OldAssistantRoute } from "../web/routes/$locale/_app/$projectKey.$envSlug.assistant";
import { Route as Variables } from "../web/routes/$locale/_app/$projectKey.$envSlug.variables";
import { Route as ProjectAssistantRoute } from "../web/routes/$locale/_app/$projectKey.assistant";
import { Route as Overview } from "../web/routes/$locale/_app/$projectKey.index";
import { Route as Milestones } from "../web/routes/$locale/_app/$projectKey.milestones";
import { Route as GlobalAssistantRoute } from "../web/routes/$locale/_app/assistant";

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
        params: { locale: "en", projectKey: "HMEM" },
      })
    );
    expect(href).toMatch(/\/HMEM$/);
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

const ENV_ID = "3f0c2a52-2a7e-4d1b-9a43-6f1f6f0f0e01";
const CONV_ID = "8b9d7a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";

/** A router context whose query client knows one visible project. */
const withProjects = {
  queryClient: {
    query: async () => [
      { id: PROJECT_ID, key: "HMEM", name: "Heron Membership" },
    ],
  },
};

describe("old assistant URLs", () => {
  it("the environment page redirects to /assistant with the environment", async () => {
    const href = await redirectOf(() =>
      (OldAssistantRoute.options.beforeLoad as Loader)({
        params: { locale: "en", projectKey: "HMEM", envSlug: "dev" },
        context: { environmentId: ENV_ID },
      })
    );
    expect(href).toBe(`/en/assistant?env=${ENV_ID}`);
  });

  it("the project page redirects to /assistant with the project", async () => {
    const href = await redirectOf(() =>
      (ProjectAssistantRoute.options.beforeLoad as Loader)({
        params: { locale: "en", projectKey: "HMEM" },
        context: withProjects,
        search: {},
      })
    );
    expect(href).toBe(`/en/assistant?project=${PROJECT_ID}`);
  });

  it("a project-page conversation link keeps its conversation and environment", async () => {
    const run = (search: object) =>
      redirectOf(() =>
        (ProjectAssistantRoute.options.beforeLoad as Loader)({
          params: { locale: "en", projectKey: "HMEM" },
          context: withProjects,
          search,
        })
      );
    expect(await run({ c: CONV_ID })).toBe(`/en/assistant?c=${CONV_ID}`);
    expect(await run({ c: CONV_ID, env: ENV_ID })).toBe(
      `/en/assistant?c=${CONV_ID}&env=${ENV_ID}`
    );
    expect(await run({ env: ENV_ID })).toBe(`/en/assistant?env=${ENV_ID}`);
  });

  it("an unknown or invisible project key is not found", async () => {
    await expect(
      (ProjectAssistantRoute.options.beforeLoad as Loader)({
        params: { locale: "en", projectKey: "NOPE" },
        context: withProjects,
        search: {},
      })
    ).rejects.toSatisfy(isNotFound);
  });

  it("the old project page still reads ?env and ?c as uuids", () => {
    const schema = ProjectAssistantRoute.options.validateSearch as {
      parse: (s: object) => { env?: string; c?: string };
    };
    expect(schema.parse({ env: ENV_ID, c: CONV_ID })).toEqual({
      env: ENV_ID,
      c: CONV_ID,
    });
    expect(schema.parse({ env: "dev", c: 42 })).toEqual({
      env: undefined,
      c: undefined,
    });
  });

  it("/assistant reads ?c, ?project and ?env as uuids and drops anything else", () => {
    const schema = GlobalAssistantRoute.options.validateSearch as {
      parse: (s: object) => { c?: string; project?: string; env?: string };
    };
    expect(
      schema.parse({ c: CONV_ID, project: PROJECT_ID, env: ENV_ID })
    ).toEqual({ c: CONV_ID, project: PROJECT_ID, env: ENV_ID });
    expect(schema.parse({ c: "x", project: "HMEM", env: 1 })).toEqual({
      c: undefined,
      project: undefined,
      env: undefined,
    });
  });

  it("assistant stays a reserved project page, never an environment slug", () => {
    expect(RESERVED_ENV_SLUGS.has("assistant")).toBe(true);
    expect(parseNavPath("/HMEM/assistant")).toMatchObject({
      scope: "project",
      page: "assistant",
    });
  });
});
