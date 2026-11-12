// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";

const api = vi.hoisted(() => ({
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: async () => true }),
}));
vi.mock("@/web/api/project-members", () => ({
  addProjectMember: api.addProjectMember,
  removeProjectMember: api.removeProjectMember,
  listProjectMembersQuery: (id: string) => ({
    queryKey: ["members", id],
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
  listMemberCandidatesQuery: (id: string) => ({
    queryKey: ["candidates", id],
    queryFn: async () => [
      { id: "u9", name: "Aisha", email: "a@x", image: null },
    ],
  }),
}));

import type { ProjectMemberRow } from "@/web/api/project-members";
import {
  ProjectMembersClient,
  ProjectMembersTab,
} from "../web/routes/$locale/_app/-components/project/project-members-client";
import {
  projectSettingsSearch,
  visibleSettingsTab,
} from "../web/routes/$locale/_app/-components/project/project-settings-search";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

const member = (id: string, name: string, orgRole: string) =>
  ({
    userId: id,
    name,
    email: `${name.toLowerCase()}@x`,
    image: null,
    orgRole,
  }) as unknown as ProjectMemberRow;

async function render(
  members: ProjectMemberRow[],
  candidates: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  }[] = []
) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ProjectMembersClient
            projectId={PROJECT}
            projectName="CAR Membership"
            initialMembers={members}
            memberCandidates={candidates}
          />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

const text = () => container?.textContent ?? "";

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => (el as HTMLElement).click());
}

const byText = (selector: string, label: string) =>
  [...document.querySelectorAll(selector)].find((el) =>
    el.textContent?.trim().startsWith(label)
  );

afterEach(() => {
  const mounted = root;
  if (mounted) act(() => mounted.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("project settings tab helpers", () => {
  it("parses only known tabs", () => {
    expect(projectSettingsSearch({ tab: "members" })).toEqual({
      tab: "members",
    });
    expect(projectSettingsSearch({ tab: "bogus" })).toEqual({});
  });
  it("falls back to details for a tab the caller may not open", () => {
    expect(
      visibleSettingsTab("members", { members: false, danger: true })
    ).toBe("details");
    expect(visibleSettingsTab("danger", { members: true, danger: false })).toBe(
      "details"
    );
    expect(visibleSettingsTab(undefined, { members: true, danger: true })).toBe(
      "details"
    );
    expect(
      visibleSettingsTab("members", { members: true, danger: false })
    ).toBe("members");
  });
});

describe("Members tab", () => {
  it("lists every member with a read-only global role badge", async () => {
    await render([
      member("u1", "Rina", "engineer"),
      member("u2", "Wella", "qa"),
      member("u3", "Dede", "admin"),
    ]);
    expect(text()).toContain("Rina");
    expect(text()).toContain("Engineer");
    expect(text()).toContain("QA / BA");
    expect(text()).toContain("Admin");
    // Only the user picker: no per-member role select.
    expect(
      container?.querySelectorAll('button[aria-label="Select a user…"]')
    ).toHaveLength(1);
  });

  it("adds the picked user without a role", async () => {
    api.addProjectMember.mockResolvedValue({ success: true });
    await render([], [{ id: "u9", name: "Aisha", email: "a@x", image: null }]);
    await click(
      container?.querySelector('button[aria-label="Select a user…"]')
    );
    // The popup mounts in a portal, a tick after the click.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await click(
      [...document.querySelectorAll('[data-slot="combobox-item"]')].find((el) =>
        el.textContent?.includes("Aisha")
      )
    );
    await click(byText("button", messages.projectMembers.add));
    expect(api.addProjectMember).toHaveBeenCalledWith({
      projectId: PROJECT,
      userId: "u9",
    });
  });

  it("removes a member after confirming", async () => {
    api.removeProjectMember.mockResolvedValue({ success: true });
    await render([member("u1", "Rina", "engineer")]);
    await click(container?.querySelector('button[aria-label="Remove Rina"]'));
    expect(api.removeProjectMember).toHaveBeenCalledWith({
      projectId: PROJECT,
      userId: "u1",
    });
  });
});

describe("ProjectMembersTab", () => {
  it("reads both queries and shows the roster and the candidates", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(
        <QueryClientProvider client={new QueryClient()}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <ProjectMembersTab projectId={PROJECT} projectName="CAR" />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text()).toContain("Rina");
    expect(text()).toContain("Engineer");
    // The candidate list reached the picker: it is enabled.
    expect(
      container
        .querySelector('button[aria-label="Select a user…"]')
        ?.hasAttribute("data-disabled")
    ).toBe(false);
  });
});
