// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
const APP = "0197f3a0-1b2c-7def-8000-0123456789a1";
const HRIS = "0197f3a0-1b2c-7def-8000-0123456789a2";

function sourceFixture(inUse = true) {
  return {
    appId: APP,
    appKey: "dplk-membership",
    name: "DPLK Membership",
    inUse,
    components: [
      {
        componentKey: "dplk-membership-backend",
        repoFullName: "dss/dplk-membership",
        defaultBranch: "kestrel/development",
        fallbackBranch: "main",
        environments: [
          {
            id: "e1",
            name: "Dev 1",
            slug: "dev-1",
            sourceBranch: "kestrel/development",
          },
          { id: "e2", name: "Demo", slug: "demo", sourceBranch: "kestrel/demo" },
          { id: "e3", name: "QA", slug: "qa", sourceBranch: null },
        ],
      },
    ],
  };
}

const state = vi.hoisted(() => ({
  sources: [] as unknown[],
  confirm: vi.fn(async () => true),
}));

const api = vi.hoisted(() => ({
  addProjectSource: vi.fn(async () => ({ success: true, message: "added" })),
  removeProjectSource: vi.fn(async () => ({
    success: true,
    message: "removed",
  })),
  setComponentBranch: vi.fn(async () => ({ success: true, message: "saved" })),
}));

vi.mock("@/web/api/project-sources", () => ({
  ...api,
  listProjectSourcesQuery: () => ({
    queryKey: ["sources"],
    queryFn: async () => state.sources,
  }),
}));
vi.mock("@/web/api/apps", () => ({
  listAppsQuery: () => ({
    queryKey: ["apps"],
    queryFn: async () => [
      { id: APP, appKey: "dplk-membership", name: "DPLK Membership" },
      { id: HRIS, appKey: "hris", name: "HRIS" },
    ],
  }),
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: state.confirm }),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ProjectSourcesTab } from "../web/routes/$locale/_app/-components/project/project-sources-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.projectSources;
let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

async function render(canManageApps = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ProjectSourcesTab
            project={{ id: PROJECT, key: "KMEM" }}
            canManageApps={canManageApps}
          />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const body = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")];
const button = (text: string) =>
  buttons().find((b) => b.textContent?.trim() === text);
const link = (text: string) =>
  [...document.querySelectorAll("a")].find((a) =>
    a.textContent?.includes(text)
  );
const input = () =>
  document.querySelector<HTMLInputElement>(
    `input[aria-label="${t.defaultBranch}"]`
  );

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element | undefined) {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  state.sources = [sourceFixture()];
});

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("Project settings Sources tab", () => {
  it("renders one card per app with its key, repo and environment chips", async () => {
    await render();
    expect(body()).toContain("dplk-membership");
    expect(body()).toContain("dss/dplk-membership");
    expect(body()).toContain("Dev 1 · kestrel/development");
    expect(body()).toContain(`QA · ${t.noTarget}`);
    expect(link("Dev 1")?.getAttribute("href")).toMatch(
      /\/KMEM\/dev-1\/settings\?tab=source$/
    );
  });

  it("marks a chip whose branch differs from the default", async () => {
    await render();
    const marked = [...document.querySelectorAll("a")].filter((a) =>
      a.textContent?.includes(t.differs)
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("Demo");
    expect(body().split(t.differs)).toHaveLength(2);
  });

  it("compares with the fallback branch when no default is set", async () => {
    const source = sourceFixture();
    state.sources = [
      {
        ...source,
        components: source.components.map((c) => ({
          ...c,
          defaultBranch: null,
        })),
      },
    ];
    await render();
    // The fallback is "main": both environments with a target differ from it.
    expect(body().split(t.differs)).toHaveLength(3);
  });

  it("Remove is disabled while the app is in use", async () => {
    await render();
    expect(button(t.remove)?.disabled).toBe(true);
    await act(async () => root?.unmount());
    container?.remove();
    state.sources = [sourceFixture(false)];
    await render();
    expect(button(t.remove)?.disabled).toBe(false);
    await click(button(t.remove));
    expect(state.confirm).toHaveBeenCalled();
    expect(api.removeProjectSource).toHaveBeenCalledWith({
      projectId: PROJECT,
      appId: APP,
    });
  });

  it("Save stays disabled for an invalid branch", async () => {
    await render();
    const field = input();
    expect(field).toBeTruthy();
    expect(button(t.save)?.disabled).toBe(true);
    await type(field as HTMLInputElement, "feature..x");
    expect(button(t.save)?.disabled).toBe(true);
    expect(body()).toContain(t.invalidBranch);
    await type(field as HTMLInputElement, "kestrel/release");
    expect(button(t.save)?.disabled).toBe(false);
    await click(button(t.save));
    expect(api.setComponentBranch).toHaveBeenCalledWith({
      projectId: PROJECT,
      componentKey: "dplk-membership-backend",
      branch: "kestrel/release",
    });
  });

  it("Add app offers only catalog apps that are not sources", async () => {
    await render();
    await click(button(t.addApp));
    await click(
      document.querySelector('[data-slot="combobox-trigger"]') ?? undefined
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent
    );
    expect(options.join(" ")).toContain("hris");
    expect(options.join(" ")).not.toContain("dplk-membership");
    expect(body()).toContain(t.registerHint);
    expect(link(t.openNewEnvironment)?.getAttribute("href")).toMatch(
      /\/KMEM\/environments\/new$/
    );
  });

  it("the empty state explains auto-add and links to New environment", async () => {
    state.sources = [];
    await render();
    expect(body()).toContain(t.emptyTitle);
    expect(body()).toContain(t.emptyDescription);
    expect(link(t.openNewEnvironment)?.getAttribute("href")).toMatch(
      /\/KMEM\/environments\/new$/
    );
  });

  it("without environment:create, Add app and Remove are hidden", async () => {
    await render(false);
    expect(button(t.addApp)).toBeUndefined();
    expect(button(t.remove)).toBeUndefined();
    await type(input() as HTMLInputElement, "kestrel/release");
    await click(button(t.save));
    expect(api.setComponentBranch).toHaveBeenCalled();
  });
});
