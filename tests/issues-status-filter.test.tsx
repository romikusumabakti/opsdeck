import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { resolveStatusFilter } from "@/lib/issue-query";
import messages from "@/messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  usePathname: () => "/CMEM/issues",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock("@/hooks/use-project-name", () => ({
  useProjectName: () => "Core",
}));

import {
  IssuesClient,
  statusFilterHref,
} from "@/web/routes/$locale/_app/-components/issues-client";

function render(status: string | undefined) {
  return renderToString(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <IssuesClient
        projectId="p"
        projectKey="CMEM"
        currentEnvironmentId=""
        environments={[]}
        users={[]}
        milestones={[]}
        initialIssues={[]}
        status={status}
      />
    </IntlProvider>
  );
}

describe("issues status filter", () => {
  it("defaults to open + in progress", () => {
    expect(resolveStatusFilter(undefined, "table")).toEqual([
      "open",
      "in_progress",
    ]);
    expect(render(undefined)).toContain("Active");
  });

  it("choosing All lifts the default, a single status narrows to it", () => {
    expect(resolveStatusFilter("all", "table")).toBeNull();
    expect(render("all")).toContain("All statuses");
    expect(resolveStatusFilter("closed", "table")).toEqual(["closed"]);
    expect(render("closed")).toContain("Closed");
  });
});

describe("statusFilterHref", () => {
  it("keeps the overview's tab when the status changes", () => {
    const search = new URLSearchParams("tab=issues");
    expect(statusFilterHref("/CMEM", search, "closed")).toBe(
      "/CMEM?tab=issues&status=closed"
    );
    expect(
      statusFilterHref(
        "/CMEM",
        new URLSearchParams("tab=issues&status=closed"),
        "active"
      )
    ).toBe("/CMEM?tab=issues");
    expect(
      statusFilterHref("/CMEM/issues", new URLSearchParams(), "active")
    ).toBe("/CMEM/issues");
  });
});
