// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "Menara",
  allowedEmailDomain: "example.com",
});

// The sidebar's own logic (which rows, for which role), not the shadcn
// sidebar primitives: those are stubbed to plain elements.

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => nav.pathname,
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
vi.mock("@/components/active-runs-provider", () => ({
  useActiveRunCount: () => 0,
  useActiveRuns: () => [],
}));
vi.mock("@/components/motif-provider", () => ({
  useMotif: () => ({ motif: null }),
}));
vi.mock("@/components/brand-mark", () => ({ BrandLogo: () => null }));
vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/ui/sidebar", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Sidebar: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarGroup: Pass,
    SidebarGroupContent: Pass,
    SidebarGroupLabel: ({ children }: { children?: React.ReactNode }) => (
      <h2>{children}</h2>
    ),
    SidebarHeader: Pass,
    SidebarMenu: ({ children }: { children?: React.ReactNode }) => (
      <ul>{children}</ul>
    ),
    SidebarMenuItem: ({ children }: { children?: React.ReactNode }) => (
      <li>{children}</li>
    ),
    SidebarMenuButton: ({
      render,
      children,
      isActive,
    }: {
      render: React.ReactElement;
      children?: React.ReactNode;
      isActive?: boolean;
    }) =>
      React.cloneElement(
        render,
        { "data-active": isActive ? "true" : undefined } as object,
        children
      ),
  };
});

import { AppSidebar } from "@/components/app-sidebar";
import { ORG_ROLES, type OrgRole } from "@/lib/permissions";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderSidebar(
  orgRole: OrgRole,
  pathname: string,
  scope: {
    environments?: unknown[];
    projects?: unknown[];
    projectRoles?: Record<string, string>;
    assistantEnabled?: boolean;
  } = {}
) {
  nav.pathname = pathname;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <AppSidebar
          environments={(scope.environments ?? []) as never}
          projects={(scope.projects ?? []) as never}
          orgRole={orgRole}
          projectRoles={(scope.projectRoles ?? {}) as never}
          issueCounts={{ total: 0 } as never}
          openCounts={{}}
          user={
            {
              id: "u",
              name: "U",
              email: "u@example.com",
              image: null,
            } as never
          }
          logo={"menara" as never}
          assistantEnabled={scope.assistantEnabled}
        />
      </IntlProvider>
    );
  });
}

const hrefs = () =>
  [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

/** A sidebar group's rows, in order (the list under its label). */
function groupRows(heading: string): string[] {
  const label = [...container.querySelectorAll("h2")].find(
    (h) => h.textContent === heading
  );
  const list = label?.parentElement?.querySelector("ul");
  return [...(list?.querySelectorAll("a") ?? [])].map(
    (a) => a.textContent ?? ""
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("app sidebar", () => {
  it.each(ORG_ROLES)("has no Apps entry for %s", async (role) => {
    await renderSidebar(role, "/");
    expect(hrefs().some((h) => h === "/apps" || h?.startsWith("/apps/"))).toBe(
      false
    );
  });

  it("admin group: Activity, Users, Repositories, Storage, Instance, then Integrations: Jira, CI, Cloudflare, Assistant; no Tunnels", async () => {
    await renderSidebar("admin", "/admin/activity");
    expect(groupRows(messages.nav.admin)).toEqual([
      messages.nav.activity,
      messages.nav.users,
      messages.nav.repositories,
      messages.nav.storage,
      messages.nav.instance,
    ]);
    expect(groupRows(messages.nav.integrations)).toEqual([
      messages.nav.jira,
      messages.nav.ci,
      messages.nav.cloudflare,
      messages.nav.assistant,
    ]);
    const headings = [...container.querySelectorAll("h2")].map(
      (h) => h.textContent
    );
    expect(headings.indexOf(messages.nav.integrations)).toBe(
      headings.indexOf(messages.nav.admin) + 1
    );
    expect(hrefs()).toContain("/admin/repositories");
    expect(hrefs()).toContain("/admin/instance");
    expect(hrefs().some((h) => h?.startsWith("/admin/tunnels"))).toBe(false);
  });

  it("keeps Servers in the main navigation and has no global Storage entry", async () => {
    await renderSidebar("admin", "/admin/activity");
    expect(hrefs()).toContain("/servers");
    expect(hrefs()).not.toContain("/storage");
  });

  it("shows Servers to an engineer, without a global Storage entry", async () => {
    await renderSidebar("engineer", "/", { projectRoles: { p1: "engineer" } });
    expect(hrefs()).toContain("/servers");
    expect(hrefs()).not.toContain("/storage");
  });

  it("hides Servers from a QA", async () => {
    await renderSidebar("qa", "/", { projectRoles: { p1: "qa" } });
    expect(hrefs()).not.toContain("/servers");
  });

  it("lists Admin › Storage for storage managers only", async () => {
    await renderSidebar("admin", "/admin/activity");
    expect(hrefs()).toContain("/admin/storage");
    act(() => root.unmount());
    container.remove();
    await renderSidebar("observer", "/admin/activity");
    expect(hrefs()).not.toContain("/admin/storage");
  });

  it("shows an observer only the admin rows its role allows", async () => {
    await renderSidebar("observer", "/admin/activity");
    expect(groupRows(messages.nav.admin)).toEqual([
      messages.nav.activity,
      messages.nav.users,
    ]);
    // No integration it may open, so no empty Integrations label.
    expect(
      [...container.querySelectorAll("h2")].some(
        (h) => h.textContent === messages.nav.integrations
      )
    ).toBe(false);
  });
});

describe("staff sidebar", () => {
  it("shows Home and Knowledge only", async () => {
    await renderSidebar("staff", "/", { assistantEnabled: true });
    // "/" twice: the logo and Home.
    expect(hrefs()).toEqual(["/", "/", "/knowledge"]);
  });

  it("still shows the other roles Projects, Issues and People", async () => {
    await renderSidebar("ba", "/", { projectRoles: { p1: "qa" } });
    expect(hrefs()).toEqual(
      expect.arrayContaining(["/projects", "/issues", "/people", "/knowledge"])
    );
  });
});

describe("project group", () => {
  // Releases exist only for legacy jar/static components (spec 2026-11-11
  // decision 7): a container-only project gets no Releases entry.
  const env = (projectReleasable: boolean) => ({
    id: "e1",
    projectId: "p1",
    key: "HMEM",
    slug: "dev",
    name: "Dev",
    kind: "dev",
    hasMailpit: false,
    serviceRoles: [],
    projectReleasable,
  });
  const projects = [{ id: "p1", key: "HMEM", name: "Heron Membership" }];
  const scope = (releasable: boolean) => ({
    environments: [env(releasable)],
    projects,
    projectRoles: { p1: "engineer" },
  });
  const linkByHref = (href: string) =>
    [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === href
    );

  it("shows on a project page with every project item", async () => {
    await renderSidebar("engineer", "/HMEM/issues", scope(true));
    expect(groupRows("Heron Membership")).toEqual([
      "Environments",
      "Issues",
      "Releases",
      "Settings",
    ]);
  });

  it("shows above the environment group inside an environment", async () => {
    await renderSidebar("engineer", "/HMEM/dev/deploys", scope(true));
    const headings = [...container.querySelectorAll("h2")].map(
      (h) => h.textContent
    );
    expect(headings.indexOf("Heron Membership")).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf("Heron Membership")).toBeLessThan(
      headings.indexOf("Dev")
    );
  });

  it.each(["engineer", "qa", "ba"] as const)(
    "gives the environment group a Storage entry for %s",
    async (role) => {
      await renderSidebar(role, "/HMEM/dev/deploys", {
        ...scope(true),
        projectRoles: { p1: role === "engineer" ? "engineer" : "qa" },
      });
      expect(groupRows("Dev")).toContain(messages.nav.storage);
      expect(hrefs()).toContain("/HMEM/dev/storage");
    }
  );

  it("marks Storage active on its sub-pages", async () => {
    await renderSidebar("engineer", "/HMEM/dev/storage/new", scope(true));
    expect(linkByHref("/HMEM/dev/storage")?.getAttribute("data-active")).toBe(
      "true"
    );
  });

  it("the environment group has no Services entry", async () => {
    await renderSidebar("engineer", "/HMEM/dev/deploys", scope(true));
    expect(groupRows("Dev")).not.toContain("Services");
    expect(hrefs().filter((h) => h?.endsWith("/services"))).toEqual([]);
  });

  it("keeps Releases and Issues out of the environment group", async () => {
    await renderSidebar("engineer", "/HMEM/dev/deploys", scope(true));
    expect(groupRows("Dev")).not.toContain("Releases");
    expect(groupRows("Dev")).not.toContain("Issues");
  });

  it("the environment group has no Variables entry", async () => {
    await renderSidebar("engineer", "/HMEM/dev/deploys", scope(true));
    expect(groupRows("Dev")).not.toContain("Variables");
    expect(hrefs().some((h) => h?.endsWith("/variables"))).toBe(false);
  });

  it("has no Releases entry for a container-only project", async () => {
    await renderSidebar("engineer", "/HMEM/dev/deploys", scope(false));
    expect(groupRows("Heron Membership")).not.toContain("Releases");
    expect(hrefs()).not.toContain("/HMEM/releases");
  });

  it("renders for a project without environments", async () => {
    await renderSidebar("engineer", "/HMEM", {
      environments: [],
      projects,
      projectRoles: { p1: "engineer" },
    });
    expect(groupRows("Heron Membership")).toContain("Environments");
    expect(groupRows("Heron Membership")).not.toContain("Releases");
  });

  it("has no Overview entry", async () => {
    await renderSidebar("engineer", "/HMEM/issues", scope(true));
    expect(groupRows("Heron Membership")).not.toContain("Overview");
  });

  it("renders no group for an unknown project key", async () => {
    await renderSidebar("engineer", "/NOPE/issues", scope(true));
    expect(groupRows("Heron Membership")).toEqual([]);
  });

  it("marks Issues active on an issue page, not Environments", async () => {
    await renderSidebar("engineer", "/HMEM/issues/42", scope(true));
    expect(linkByHref("/HMEM/issues")?.getAttribute("data-active")).toBe(
      "true"
    );
    expect(linkByHref("/HMEM")?.getAttribute("data-active")).toBeNull();
  });

  it("does not mark Issues active on an environment slugged issues-old", async () => {
    await renderSidebar("engineer", "/HMEM/issues-old/deploys", {
      ...scope(true),
      environments: [{ ...env(true), slug: "issues-old" }],
    });
    expect(linkByHref("/HMEM/issues")?.getAttribute("data-active")).toBeNull();
  });

  it("marks Environments active on the project page", async () => {
    await renderSidebar("engineer", "/HMEM", scope(true));
    expect(linkByHref("/HMEM")?.getAttribute("data-active")).toBe("true");
  });

  it("keeps Assistant out of the project and environment groups", async () => {
    await renderSidebar("engineer", "/HMEM/dev/deploys", {
      ...scope(true),
      assistantEnabled: true,
    });
    expect(groupRows("Heron Membership")).toEqual([
      "Environments",
      "Issues",
      "Releases",
      "Settings",
    ]);
    expect(groupRows("Dev")).not.toContain("Assistant");
    expect(hrefs()).not.toContain("/HMEM/assistant");
    expect(hrefs()).not.toContain("/HMEM/dev/assistant");
  });
});

describe("top-level Assistant entry", () => {
  const projects = [{ id: "p1", key: "HMEM", name: "Heron Membership" }];
  const linkByHref = (href: string) =>
    [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === href
    );

  it("follows Issues in the main navigation once enabled", async () => {
    await renderSidebar("qa", "/", {
      projects,
      projectRoles: { p1: "qa" },
      assistantEnabled: true,
    });
    const main = hrefs();
    expect(main.indexOf("/assistant")).toBe(main.indexOf("/issues") + 1);
  });

  it("is hidden while the assistant is off", async () => {
    await renderSidebar("engineer", "/", {
      projects,
      projectRoles: { p1: "engineer" },
    });
    expect(hrefs()).not.toContain("/assistant");
  });

  it("is hidden from a user who sees no project", async () => {
    await renderSidebar("engineer", "/", { assistantEnabled: true });
    expect(hrefs()).not.toContain("/assistant");
  });

  it("is active on the assistant page", async () => {
    await renderSidebar("engineer", "/assistant", {
      projects,
      projectRoles: { p1: "engineer" },
      assistantEnabled: true,
    });
    expect(linkByHref("/assistant")?.getAttribute("data-active")).toBe("true");
  });
});
