// @vitest-environment happy-dom
import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Old app URLs (Review Focus 5): `/admin/repositories/$appKey…` and
// `/apps/…` lead to the service of a one-service app, to the Services list
// filtered by repository for a multi-service one, else to the list.

const api = vi.hoisted(() => ({ resolveLegacyApp: vi.fn() }));
vi.mock("@/web/api/service-catalog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveLegacyApp: api.resolveLegacyApp,
}));

const { legacyServicesHref } = await import(
  "../web/routes/$locale/_app/-components/services/legacy-redirect"
);
const { Route: Repositories } = await import(
  "../web/routes/$locale/_app/admin.repositories.index"
);
const { Route: Repository } = await import(
  "../web/routes/$locale/_app/admin.repositories.$appKey.index"
);
const { Route: RepositoryVariables } = await import(
  "../web/routes/$locale/_app/admin.repositories.$appKey.variables"
);
const { Route: Apps } = await import("../web/routes/$locale/_app/apps.index");
const { Route: App } = await import(
  "../web/routes/$locale/_app/apps.$appKey.index"
);
const { Route: AppVariables } = await import(
  "../web/routes/$locale/_app/apps.$appKey.variables"
);
const { Route: NewApp } = await import("../web/routes/$locale/_app/apps.new");
const { Route: AddEnvironment } = await import(
  "../web/routes/$locale/_app/apps.$appKey.environments.new"
);
const { Route: Projects } = await import(
  "../web/routes/$locale/_app/projects.index"
);

type Hook = (ctx: unknown) => unknown;

/** The href a route hook redirects to. */
async function redirectOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isRedirect(error)) return String(error.options.href);
    throw error;
  }
  throw new Error("no redirect");
}

const ONE = [{ key: "kmem-api", repoFullName: "acme/kmem-api" }];
const TWO_REPOS = [
  { key: "core-backend", repoFullName: "acme/core" },
  { key: "core-web", repoFullName: "acme/core-web" },
];
const ONE_REPO_TWO = [
  { key: "docs-search", repoFullName: "acme/docs" },
  { key: "docs-site", repoFullName: "acme/docs" },
];

beforeEach(() => {
  api.resolveLegacyApp.mockReset();
});

describe("legacyServicesHref", () => {
  it("a one-service app goes to that service's page", () => {
    expect(legacyServicesHref(ONE)).toBe("/admin/services/kmem-api");
  });

  it("a multi-service app goes to the list filtered by its repositories", () => {
    expect(legacyServicesHref(TWO_REPOS)).toBe(
      "/admin/services?repo=acme%2Fcore&repo=acme%2Fcore-web"
    );
    expect(legacyServicesHref(ONE_REPO_TWO)).toBe(
      "/admin/services?repo=acme%2Fdocs"
    );
  });

  it("an unknown app goes to the list", () => {
    expect(legacyServicesHref([])).toBe("/admin/services");
  });
});

describe("old URLs", () => {
  const hooks: [string, Hook][] = [
    [
      "/admin/repositories/$appKey",
      Repository.options.beforeLoad as unknown as Hook,
    ],
    [
      "/admin/repositories/$appKey/variables",
      RepositoryVariables.options.beforeLoad as unknown as Hook,
    ],
    ["/apps/$appKey", App.options.beforeLoad as unknown as Hook],
    [
      "/apps/$appKey/variables",
      AppVariables.options.beforeLoad as unknown as Hook,
    ],
  ];

  it.each(hooks)("%s follows the app's services", async (_path, hook) => {
    const run = (services: typeof ONE) => {
      api.resolveLegacyApp.mockResolvedValueOnce({ services });
      return redirectOf(() =>
        hook({ params: { locale: "en", appKey: "kmem" } })
      );
    };
    expect(await run(ONE)).toBe("/en/admin/services/kmem-api");
    expect(await run(TWO_REPOS)).toBe(
      "/en/admin/services?repo=acme%2Fcore&repo=acme%2Fcore-web"
    );
    expect(await run([])).toBe("/en/admin/services");
    expect(api.resolveLegacyApp).toHaveBeenCalledWith("kmem");
  });

  it.each(hooks)(
    "%s goes to the list when the lookup fails",
    async (_path, hook) => {
      api.resolveLegacyApp.mockRejectedValueOnce(new Error("400"));
      expect(
        await redirectOf(() =>
          hook({ params: { locale: "en", appKey: "Bad Key" } })
        )
      ).toBe("/en/admin/services");
    }
  );

  it("the old lists go to Services", async () => {
    for (const route of [Repositories, Apps]) {
      expect(
        await redirectOf(() =>
          (route.options.beforeLoad as unknown as Hook)({
            params: { locale: "en" },
          })
        )
      ).toBe("/en/admin/services");
    }
  });

  it("New app goes to the projects list with the hint", async () => {
    expect(
      await redirectOf(() =>
        (NewApp.options.beforeLoad as unknown as Hook)({
          params: { locale: "en" },
        })
      )
    ).toBe("/en/projects?newEnvironment=1");
  });

  it("Add environment goes to ?project='s New environment with the app's service", async () => {
    const run = (project: string | undefined, services: typeof ONE) => {
      api.resolveLegacyApp.mockResolvedValue({ services });
      return redirectOf(() =>
        (AddEnvironment.options.loader as unknown as Hook)({
          params: { locale: "en", appKey: "kmem" },
          deps: { project },
        })
      );
    };
    expect(await run("kmem", ONE)).toBe(
      "/en/KMEM/environments/new?service=kmem-api"
    );
    expect(await run(undefined, ONE)).toBe("/en/projects?newEnvironment=1");
    expect(await run("kmem", [])).toBe("/en/KMEM/environments/new");
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
