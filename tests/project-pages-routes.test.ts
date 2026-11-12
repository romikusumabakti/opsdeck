import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = (name: string) =>
  readFileSync(`web/routes/$locale/_app/${name}`, "utf8");
const locales = ["en", "id", "es", "zh", "ar"];

describe("project issues page", () => {
  const src = route("$projectKey.issues.index.tsx");
  it("404s an invisible project, then guards by role", () => {
    expect(src).toContain("getProjectByKeyWithEnvironmentsQuery");
    expect(src).toContain("notFound()");
    expect(src).toContain("requireProjectRole(queryClient, project.id)");
  });
  it("renders the project-level list without an environment prefill", () => {
    expect(src).toContain("IssuesClient");
    expect(src).toContain('currentEnvironmentId=""');
    expect(src).toContain("IssuesPending");
  });
  it("keeps status in the search", () => {
    expect(src).toMatch(/validateSearch[\s\S]*status/);
  });
});

describe("project members route", () => {
  const src = route("$projectKey.members.tsx");
  it("redirects to the Members tab of Project settings", () => {
    expect(src).toContain("redirect(");
    expect(src).toMatch(/`\/\$\{projectKey\}\/settings\?tab=members`/);
    expect(src).not.toContain("ProjectMembersClient");
  });
});

describe("project overview ?tab=members", () => {
  it("goes straight to the Members tab of Project settings", () => {
    const src = route("$projectKey.index.tsx");
    expect(src).toMatch(/settings\?tab=members/);
    // The members branch must run before the generic `/${tab}` redirect.
    expect(src.indexOf("settings?tab=members")).toBeLessThan(
      src.search(/`\/\$\{projectKey\}\/\$\{tab\}/)
    );
  });
});

describe("project settings page", () => {
  const src = route("$projectKey.settings.tsx");
  it("opens the tab from the search and gates Members on member:manage", () => {
    expect(src).toContain("validateSearch: projectSettingsSearch");
    expect(src).toContain('member: ["manage"]');
    expect(src).toContain("ProjectMembersTab");
  });
});

describe("project milestones route", () => {
  const src = route("$projectKey.milestones.tsx");
  it("only redirects; the page is gone", () => {
    expect(src).toContain("redirect(");
    expect(src).not.toContain("MilestonesClient");
  });
});

describe("environment issues route", () => {
  const src = route("$projectKey.$envSlug.issues.tsx");
  it("redirects to the project issues page with the search intact", () => {
    expect(src).toContain("redirect(");
    expect(src).toMatch(/`\/\$\{projectKey\}\/issues/);
    expect(src).toContain("location.searchStr");
    expect(src).not.toContain("URLSearchParams");
    expect(src).not.toContain("IssuesClient");
  });
});

describe("project overview", () => {
  const src = route("$projectKey.index.tsx");
  it("has no tab strip or Releases button", () => {
    expect(src).not.toContain("TabsList");
    expect(src).not.toContain("/releases");
  });
  it("redirects legacy ?tab= links to the pages", () => {
    expect(src).toContain("redirect(");
    for (const tab of ["issues", "members"]) {
      expect(src).toContain(tab);
    }
    expect(src).not.toMatch(/REDIRECT_TABS = \[[^\]]*milestones/);
    expect(src).toMatch(/`\/\$\{projectKey\}\/\$\{tab\}/);
    expect(src).toContain("status");
  });
});

describe("breadcrumb messages", () => {
  it.each(locales)("%s has no members or milestones crumb", (l) => {
    const m = JSON.parse(readFileSync(`messages/${l}.json`, "utf8"));
    expect(m.breadcrumbs.members).toBeUndefined();
    expect(m.breadcrumbs.milestones).toBeUndefined();
  });
});

describe("environment services route", () => {
  it("only redirects to the Dashboard", () => {
    const src = route("$projectKey.$envSlug.services.index.tsx");
    expect(src).toContain("redirect(");
    expect(src).toMatch(/`\/\$\{projectKey\}\/\$\{envSlug\}`/);
    expect(src).not.toContain("ServicesClient");
  });
  it("the legacy splat still forwards into the environment", () => {
    const src = route("projects.$key.$.tsx");
    expect(src).toMatch(/\$\{environment\.slug\}\/\$\{_splat/);
  });
  it("the logs page goes back to the Dashboard", () => {
    const src = route("$projectKey.$envSlug.services.$role.logs.tsx");
    expect(src).toContain("logs.backToDashboard");
    expect(src).not.toMatch(
      /href=\{`\/\$\{projectKey\}\/\$\{envSlug\}\/services`\}/
    );
  });
  it.each(locales)("%s has no Services nav or crumb", async (locale) => {
    const m = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as {
      nav?: Record<string, unknown>;
      breadcrumbs?: Record<string, unknown>;
      services?: {
        title?: unknown;
        subtitle?: unknown;
        logs: Record<string, unknown>;
      };
    };
    expect(m.nav?.services).toBeUndefined();
    expect(m.breadcrumbs?.services).toBeUndefined();
    expect(m.services?.title).toBeUndefined();
    expect(m.services?.subtitle).toBeUndefined();
    expect(m.services?.logs.backToServices).toBeUndefined();
    expect(typeof m.services?.logs.backToDashboard).toBe("string");
  });
});
