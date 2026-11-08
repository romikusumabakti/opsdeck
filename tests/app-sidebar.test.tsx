// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import enMessages from "../messages/en.json";

const messages = applyBranding(enMessages, {
  appName: "OpsDeck",
  allowedEmailDomain: "example.com",
});

// The sidebar's own logic (which rows, for which role), not the shadcn
// sidebar primitives: those are stubbed to plain elements.

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => nav.pathname,
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
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
    }: {
      render: React.ReactElement;
      children?: React.ReactNode;
    }) => React.cloneElement(render, {}, children),
  };
});

import { AppSidebar } from "@/components/app-sidebar";
import type { OrgRole } from "@/lib/permissions";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderSidebar(orgRole: OrgRole, pathname: string) {
  nav.pathname = pathname;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <AppSidebar
          environments={[]}
          projects={[]}
          orgRole={orgRole}
          projectRoles={{}}
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
          logo={"opsdeck" as never}
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
  it.each(["admin", "infra", "observer", "member"] as const)(
    "has no Apps entry for %s",
    async (role) => {
      await renderSidebar(role, "/");
      expect(
        hrefs().some((h) => h === "/apps" || h?.startsWith("/apps/"))
      ).toBe(false);
    }
  );

  it("admin group: Activity, Users, Repositories, then Integrations: Jira, CI, Cloudflare; no Tunnels", async () => {
    await renderSidebar("admin", "/admin/activity");
    expect(groupRows(messages.nav.admin)).toEqual([
      messages.nav.activity,
      messages.nav.users,
      messages.nav.repositories,
    ]);
    expect(groupRows(messages.nav.integrations)).toEqual([
      messages.nav.jira,
      messages.nav.ci,
      messages.nav.cloudflare,
    ]);
    const headings = [...container.querySelectorAll("h2")].map(
      (h) => h.textContent
    );
    expect(headings.indexOf(messages.nav.integrations)).toBe(
      headings.indexOf(messages.nav.admin) + 1
    );
    expect(hrefs()).toContain("/admin/repositories");
    expect(hrefs().some((h) => h?.startsWith("/admin/tunnels"))).toBe(false);
  });

  it("keeps Servers and Storage in the main navigation", async () => {
    await renderSidebar("admin", "/admin/activity");
    expect(hrefs()).toEqual(expect.arrayContaining(["/servers", "/storage"]));
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
