// @vitest-environment happy-dom
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { Route as AddEnvironment } from "../web/routes/$locale/_app/apps.$appKey.environments.new";
import { Route as NewApp } from "../web/routes/$locale/_app/apps.new";
import { Route as Projects } from "../web/routes/$locale/_app/projects.index";

const APP = "0197f3a0-1b2c-7def-8000-0123456789a1";

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

function queryClient(projects: { key: string; appIds: string[] }[]) {
  return {
    query: async ({ queryKey }: { queryKey: unknown[] }) =>
      queryKey[1] === "listApps"
        ? [
            {
              id: APP,
              appKey: "kmem",
              components: [{ repoFullName: "dss/kmem-api" }],
            },
          ]
        : projects.map((p) => ({
            key: p.key,
            environments: p.appIds.map((appId) => ({ appId })),
          })),
  };
}

type Loader = (ctx: unknown) => unknown;
const addEnvironment = (
  projects: { key: string; appIds: string[] }[],
  project?: string,
  appKey = "kmem"
) =>
  redirectOf(() =>
    (AddEnvironment.options.loader as Loader)({
      params: { locale: "en", appKey },
      deps: { project },
      context: { queryClient: queryClient(projects) },
    })
  );

describe("legacy New app and Add environment URLs", () => {
  it("apps/new goes to the projects list with the hint", async () => {
    const href = await redirectOf(() =>
      (NewApp.options.beforeLoad as Loader)({ params: { locale: "en" } })
    );
    expect(href).toMatch(/\/projects\?newEnvironment=1$/);
  });

  it("an app in one project goes to its New environment with the repo", async () => {
    const href = await addEnvironment([
      { key: "KMEM", appIds: [APP] },
      { key: "HRIS", appIds: [] },
    ]);
    expect(href).toMatch(/\/KMEM\/environments\/new\?repo=dss%2Fkmem-api$/);
  });

  it("?project= picks the project", async () => {
    const href = await addEnvironment(
      [
        { key: "KMEM", appIds: [APP] },
        { key: "HRIS", appIds: [APP] },
      ],
      "hris"
    );
    expect(href).toMatch(/\/HRIS\/environments\/new\?repo=dss%2Fkmem-api$/);
  });

  it("an app in several projects, or none, goes to the projects list", async () => {
    for (const projects of [
      [
        { key: "KMEM", appIds: [APP] },
        { key: "HRIS", appIds: [APP] },
      ],
      [{ key: "KMEM", appIds: [] }],
    ]) {
      expect(await addEnvironment(projects)).toMatch(
        /\/projects\?newEnvironment=1$/
      );
    }
    expect(
      await addEnvironment([{ key: "KMEM", appIds: [APP] }], undefined, "gone")
    ).toMatch(/\/projects\?newEnvironment=1$/);
  });

  it("the projects list reads the hint flag", () => {
    const validate = Projects.options.validateSearch as (
      search: Record<string, unknown>
    ) => { newEnvironment?: boolean };
    expect(validate({ newEnvironment: 1 }).newEnvironment).toBe(true);
    expect(validate({ newEnvironment: "1" }).newEnvironment).toBe(true);
    expect(validate({}).newEnvironment).toBeUndefined();
  });
});
