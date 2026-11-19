// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The Projects page offers "Manage groups" to admins only, including before
// the first project exists; with zero or one group it shows the plain grid and
// with several, sections with "No group" last.

const state = vi.hoisted(() => ({
  orgRole: "admin" as string,
  projects: [] as unknown[],
  groups: [] as unknown[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createFileRoute: () => (options: object) => ({
    options,
    useSearch: () => ({}),
  }),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects",
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/new-project-button", () => ({
  NewProjectButton: () => <button type="button">New project</button>,
}));
vi.mock("@/components/project-create-dialog", () => ({
  ProjectCreateDialog: () => null,
}));
vi.mock("@/web/project-guard", () => ({ requireProjectUser: vi.fn() }));
vi.mock("@/web/api/project-groups", () => ({
  listGroupsQuery: () => ({
    queryKey: ["project-groups", "listGroups", []],
    queryFn: async () => state.groups,
  }),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  reorderGroup: vi.fn(),
  mergeGroups: vi.fn(),
  deleteGroup: vi.fn(),
}));
vi.mock("@/web/api/project-catalog", () => ({
  listProjectsWithEnvironmentsQuery: () => ({
    queryKey: ["projects"],
    queryFn: async () => state.projects,
  }),
  getMyProjectAccessQuery: () => ({
    queryKey: ["access"],
    queryFn: async () => ({ roles: {} }),
  }),
}));
vi.mock("@/web/api/environments", () => ({
  getEnvironmentsLastOpenedQuery: () => ({
    queryKey: ["opened"],
    queryFn: async () => ({}),
  }),
}));
vi.mock("@/web/api/issues", () => ({
  getOpenIssueCountsQuery: () => ({
    queryKey: ["open-issues"],
    queryFn: async () => ({}),
  }),
}));
vi.mock("@/web/api/runs", () => ({
  getEnvironmentsLastActivityQuery: () => ({
    queryKey: ["activity"],
    queryFn: async () => ({}),
  }),
}));
vi.mock("@/web/api/session", () => ({
  meQuery: () => ({ queryKey: ["me"], queryFn: async () => null }),
  useMe: () => ({ user: { id: "u1" }, orgRole: state.orgRole }),
}));

import { Route } from "../web/routes/$locale/_app/projects.index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const group = (id: string, name: string, rank: string) => ({
  id,
  name,
  rank,
  projectCount: 1,
});
const project = (key: string, groupId: string | null) => ({
  id: `p-${key}`,
  key,
  name: `Proj ${key}`,
  groupId,
  environments: [],
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Page = (Route as unknown as { options: { component: React.FC } })
    .options.component;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <Page />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const manage = () =>
  [...container.querySelectorAll("button")].some(
    (b) => b.textContent === messages.projectGroups.manage
  );
const headings = () =>
  [...container.querySelectorAll("h2")].map((h) => h.textContent);

beforeEach(() => {
  localStorage.clear();
  state.orgRole = "admin";
  state.projects = [];
  state.groups = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Projects page", () => {
  it("offers Manage groups to an admin with no project yet", async () => {
    await renderPage();
    expect(container.textContent).toContain(messages.projectsEmpty.title);
    expect(manage()).toBe(true);
  });

  it("offers Manage groups to an admin beside New project", async () => {
    state.projects = [project("AAA", null)];
    await renderPage();
    expect(manage()).toBe(true);
  });

  it("shows no Manage groups entry to an engineer", async () => {
    state.orgRole = "engineer";
    state.projects = [project("AAA", null)];
    await renderPage();
    expect(container.textContent).toContain("Proj AAA");
    expect(manage()).toBe(false);
  });

  it("shows no Manage groups entry to an engineer in the empty state", async () => {
    state.orgRole = "engineer";
    await renderPage();
    expect(manage()).toBe(false);
  });

  it("renders the plain grid for zero or one group", async () => {
    state.projects = [project("AAA", "g1"), project("BBB", null)];
    state.groups = [group("g1", "Alpha", "a0")];
    await renderPage();
    expect(headings()).toEqual([]);
    expect(container.textContent).toContain("Proj AAA");
    expect(container.textContent).toContain("Proj BBB");
  });

  it("renders sections with No group last for several groups", async () => {
    state.projects = [
      project("AAA", null),
      project("BBB", "g2"),
      project("CCC", "g1"),
    ];
    state.groups = [group("g1", "Alpha", "a0"), group("g2", "Bravo", "a1")];
    await renderPage();
    expect(headings()).toEqual(["Alpha1", "Bravo1", "No group1"]);
  });
});
