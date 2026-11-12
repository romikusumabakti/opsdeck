// @vitest-environment happy-dom
import type * as React from "react";
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

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined }),
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

import {
  getTrailingSegments,
  HeaderBreadcrumb,
} from "@/components/header-breadcrumb";
import { parseNavPath } from "@/lib/nav-path";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("getTrailingSegments on project pages", () => {
  it.each([
    ["/CRMB/issues", [{ labelKey: "breadcrumbs.issues" }]],
    ["/CRMB/milestones", []],
    ["/CRMB/releases", [{ labelKey: "breadcrumbs.releases" }]],
    ["/CRMB/settings", [{ labelKey: "breadcrumbs.settings" }]],
    ["/CRMB/environments/new", [{ labelKey: "breadcrumbs.newEnvironment" }]],
    ["/CRMB", []],
  ])("%s trails with %j", (path, expected) => {
    const got = getTrailingSegments(parseNavPath(path), null);
    expect(got).toHaveLength(expected.length);
    expect(got).toMatchObject(expected);
  });

  it("links Issues and names the issue on a detail page", () => {
    expect(
      getTrailingSegments(parseNavPath("/CRMB/issues/42"), null)
    ).toMatchObject([
      { href: "/CRMB/issues", labelKey: "breadcrumbs.issues" },
      { label: "CRMB-42" },
    ]);
  });
});

describe("HeaderBreadcrumb", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows no environment switcher on a project page", async () => {
    nav.pathname = "/CRMB/releases";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <HeaderBreadcrumb
            environments={[]}
            projects={[{ id: "p1", key: "CRMB", name: "CRM Banking" }]}
            orgRole={"admin" as never}
            projectRoles={{ p1: "engineer" }}
          />
        </IntlProvider>
      );
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Select environment");
    expect(text).toContain("CRM Banking");
    expect(text).toContain("Releases");
  });

  it("shows the environment switcher inside an environment", async () => {
    nav.pathname = "/CRMB/dev/deploys";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <HeaderBreadcrumb
            environments={[
              {
                id: "e1",
                projectId: "p1",
                key: "CRMB",
                slug: "dev",
                name: "Dev",
                kind: "dev",
                hasMailpit: false,
                serviceRoles: [],
                projectReleasable: true,
              } as never,
            ]}
            projects={[{ id: "p1", key: "CRMB", name: "CRM Banking" }]}
            orgRole={"admin" as never}
            projectRoles={{ p1: "engineer" }}
          />
        </IntlProvider>
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Dev");
    expect(text).toContain("Deploys");
  });

  it.each([
    ["/servers/019e/terminal", "Terminal"],
    ["/servers/019e/files", "Files"],
    ["/servers/019e", "Edit"],
  ])("names the server sub-page on %s", async (path, label) => {
    nav.pathname = path;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <HeaderBreadcrumb
            environments={[]}
            projects={[]}
            orgRole={"admin" as never}
            projectRoles={{}}
          />
        </IntlProvider>
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Servers");
    expect(text).toContain(label);
    if (label !== "Edit") expect(text).not.toContain("Edit");
  });
});
