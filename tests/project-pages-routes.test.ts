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

describe("project members page", () => {
  const src = route("$projectKey.members.tsx");
  it("requires member:manage and renders the members client", () => {
    expect(src).toContain("requireProjectRole(");
    expect(src).toContain('member: ["manage"]');
    expect(src).toContain("ProjectMembersClient");
  });
});

describe("project milestones page", () => {
  const src = route("$projectKey.milestones.tsx");
  it("guards by role and renders the milestones client", () => {
    expect(src).toContain("requireProjectRole(");
    expect(src).toContain("MilestonesClient");
  });
});

describe("environment issues route", () => {
  const src = route("$projectKey.$envSlug.issues.tsx");
  it("redirects to the project issues page with the search intact", () => {
    expect(src).toContain("redirect(");
    expect(src).toMatch(/`\/\$\{projectKey\}\/issues/);
    expect(src).toContain("URLSearchParams");
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
    for (const tab of ["issues", "milestones", "members"]) {
      expect(src).toContain(tab);
    }
    expect(src).toMatch(/`\/\$\{projectKey\}\/\$\{tab\}/);
    expect(src).toContain("status");
  });
});

describe("breadcrumb messages", () => {
  it.each(locales)("%s has breadcrumbs.milestones and .members", (l) => {
    const m = JSON.parse(readFileSync(`messages/${l}.json`, "utf8"));
    expect(typeof m.breadcrumbs.milestones).toBe("string");
    expect(typeof m.breadcrumbs.members).toBe("string");
  });
});
