// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";

const state = vi.hoisted(() => ({
  search: {} as { tab?: string },
  role: "engineer" as string,
  orgRole: "admin" as string,
  navigate: vi.fn(),
}));

// Stand in for the route object so the page component can read its search.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ projectKey: "CRMB" }),
    useSearch: () => state.search,
    useNavigate: () => state.navigate,
  }),
}));
vi.mock("@/web/api/project-catalog", () => ({
  getProjectByKeyWithEnvironmentsQuery: () => ({
    queryKey: ["project"],
    queryFn: async () => ({
      id: PROJECT,
      key: "CRMB",
      name: "CAR Membership",
      environments: [],
    }),
  }),
  getMyProjectAccessQuery: () => ({
    queryKey: ["access"],
    queryFn: async () => ({ roles: { [PROJECT]: state.role } }),
  }),
}));
vi.mock("@/web/api/jira", () => ({
  getJiraConnectionsQuery: () => ({
    queryKey: ["jira-connections"],
    queryFn: async () => [],
  }),
  getJiraLinkQuery: () => ({
    queryKey: ["jira-link"],
    queryFn: async () => null,
  }),
}));
vi.mock("@/web/api/servers", () => ({
  getServersQuery: () => ({ queryKey: ["servers"], queryFn: async () => [] }),
}));
vi.mock("@/web/api/session", () => ({
  meQuery: () => ({ queryKey: ["me"], queryFn: async () => null }),
  useMe: () => ({ orgRole: state.orgRole }),
  useCanOrg: () => () => true,
}));
vi.mock("@/web/api/project-members", () => ({
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  listProjectMembersQuery: () => ({
    queryKey: ["members"],
    queryFn: async () => [
      {
        userId: "u1",
        name: "Rina",
        email: "rina@x",
        image: null,
        orgRole: "engineer",
      },
    ],
  }),
  listMemberCandidatesQuery: () => ({
    queryKey: ["candidates"],
    queryFn: async () => [],
  }),
}));
vi.mock("@/web/project-guard", () => ({
  requireProjectRole: vi.fn(),
  projectRoleOf: vi.fn(),
}));
vi.mock("@/web/query-client", () => ({ loaderQuery: vi.fn() }));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: async () => true }),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/project-form", () => ({
  ProjectForm: () => <p>details-form</p>,
}));
vi.mock("@/components/jira-link-card", () => ({
  JiraLinkCard: () => <p>jira-card</p>,
}));
vi.mock(
  "../web/routes/$locale/_app/-components/project/delete-project-card",
  () => ({
    DeleteProjectCard: () => <p>danger-card</p>,
  })
);

import { Route } from "../web/routes/$locale/_app/$projectKey.settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.projectSettings;
let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

async function renderPage(
  search: { tab?: string },
  opts: { role?: string; orgRole?: string } = {}
) {
  state.search = search;
  state.role = opts.role ?? "engineer";
  state.orgRole = opts.orgRole ?? "admin";
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Page = (Route as unknown as { options: { component: React.FC } })
    .options.component;
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Page />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  // Let the suspense queries resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const tabs = () =>
  [...document.querySelectorAll('[role="tab"]')].map((el) =>
    el.textContent?.trim()
  );
const selectedTab = () =>
  document
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.textContent?.trim();
const body = () => document.body.textContent ?? "";

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("Project settings tab wiring", () => {
  it("opens the Members tab for a caller with member:manage", async () => {
    await renderPage({ tab: "members" });
    expect(tabs()).toContain(t.tabMembers);
    expect(selectedTab()).toBe(t.tabMembers);
    expect(body()).toContain("Rina");
    expect(body()).not.toContain("details-form");
  });

  it("falls back to Details for ?tab=members without member:manage", async () => {
    await renderPage({ tab: "members" }, { role: "qa" });
    expect(tabs()).not.toContain(t.tabMembers);
    expect(selectedTab()).toBe(t.tabDetails);
    expect(body()).toContain("details-form");
    expect(body()).not.toContain("Rina");
  });

  it("falls back to Details for ?tab=danger without project:delete", async () => {
    await renderPage({ tab: "danger" }, { orgRole: "engineer" });
    expect(tabs()).not.toContain(t.tabDanger);
    expect(selectedTab()).toBe(t.tabDetails);
    expect(body()).not.toContain("danger-card");
  });

  it("opens Details for an unknown tab", async () => {
    // The route's validateSearch drops it before the page sees it.
    const search = (
      Route as unknown as {
        options: {
          validateSearch: (s: Record<string, unknown>) => { tab?: string };
        };
      }
    ).options.validateSearch({ tab: "bogus" });
    await renderPage(search);
    expect(selectedTab()).toBe(t.tabDetails);
    expect(body()).toContain("details-form");
  });
});
