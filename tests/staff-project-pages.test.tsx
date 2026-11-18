// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME_QUERY_KEY } from "@/web/query-client";

// Staff works with no project. The pages that exist only to list projects or
// what lives in them (the project list, the global issue list, the people
// directory) answer like any forbidden page: the router's not-found, as
// requireOrgRole does. Home keeps only its greeting: the assigned issues,
// running runs and recent environments sections (and their queries) are
// project-oriented and would only ever be empty.

const state = vi.hoisted(() => ({ role: "staff", fetched: [] as string[] }));

vi.mock("@/web/api/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMe: () => ({ orgRole: state.role }),
}));
vi.mock("@/web/api/home", () => {
  const query = (name: string) => () => ({
    queryKey: ["home", name],
    queryFn: async () => {
      state.fetched.push(name);
      return [];
    },
  });
  return {
    getAttentionGroupsQuery: query("attention"),
    listMyOpenIssuesQuery: query("myIssues"),
    getHomeAccessQuery: query("homeAccess"),
    listIssueProjectsQuery: query("issueProjects"),
    listRecentEnvironmentsQuery: query("recent"),
  };
});
vi.mock("@/web/routes/$locale/_app/-components/home/home-header", () => ({
  HomeHeader: ({ action }: { action?: React.ReactNode }) => (
    <h1>header{action}</h1>
  ),
}));
vi.mock("@/web/routes/$locale/_app/-components/home/main-column", () => ({
  MainColumn: () => <section>main-column</section>,
}));
vi.mock("@/web/routes/$locale/_app/-components/home/running-rail", () => ({
  RunningRail: () => <section>running-rail</section>,
}));
vi.mock(
  "@/web/routes/$locale/_app/-components/home/recent-envs-section",
  () => ({
    RecentEnvsSection: () => <section>recent-envs</section>,
  })
);
vi.mock("@/web/routes/$locale/_app/-components/home/new-issue-button", () => ({
  NewIssueButton: () => <button type="button">new-issue</button>,
}));
vi.mock("@/web/routes/$locale/_app/-components/home/home-issue-dialog", () => ({
  HomeIssueDialogProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function clientFor(role: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(ME_QUERY_KEY, { orgRole: role });
  return queryClient;
}

type Hook = (ctx: unknown) => unknown;

const GUARDED = ["people.index", "projects.index", "issues"];

async function guard(file: string): Promise<Hook> {
  const { Route } = await import(`../web/routes/$locale/_app/${file}.tsx`);
  const beforeLoad = Route.options.beforeLoad as Hook | undefined;
  if (!beforeLoad) throw new Error(`${file} has no beforeLoad`);
  return beforeLoad;
}

beforeEach(() => {
  state.fetched = [];
});

describe("project pages for staff", () => {
  it.each(GUARDED)("%s answers not found to staff", async (file) => {
    const beforeLoad = await guard(file);
    for (const role of ["staff", "legacy-role"]) {
      const error = await Promise.resolve(
        beforeLoad({ context: { queryClient: clientFor(role) } })
      ).then(
        () => null,
        (e: unknown) => e
      );
      expect(isNotFound(error), `${file} for ${role}`).toBe(true);
    }
  });

  it.each(GUARDED)("%s opens for qa, ba and pm (control)", async (file) => {
    const beforeLoad = await guard(file);
    for (const role of ["qa", "ba", "pm"]) {
      await expect(
        Promise.resolve(
          beforeLoad({ context: { queryClient: clientFor(role) } })
        )
      ).resolves.not.toThrow();
    }
  });
});

describe("Home for staff", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function renderHome(role: string) {
    state.role = role;
    const { Route } = await import("../web/routes/$locale/_app/index");
    const queryClient = clientFor(role);
    const loader = Route.options.loader as Hook;
    await loader({ context: { queryClient } });
    const Page = Route.options.component as React.ComponentType;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Page />
        </QueryClientProvider>
      );
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows only the greeting and reads no project data", async () => {
    await renderHome("staff");
    const sections = [...container.querySelectorAll("section, button")].map(
      (el) => el.textContent
    );
    expect(container.textContent).toContain("header");
    expect(sections).toEqual([]);
    expect(state.fetched).toEqual([]);
  });

  it("shows every section to a qa (control)", async () => {
    await renderHome("qa");
    const sections = [...container.querySelectorAll("section, button")].map(
      (el) => el.textContent
    );
    expect(sections).toEqual([
      "new-issue",
      "main-column",
      "running-rail",
      "recent-envs",
    ]);
    expect(state.fetched).toEqual(
      expect.arrayContaining(["issueProjects", "recent", "myIssues"])
    );
  });
});
