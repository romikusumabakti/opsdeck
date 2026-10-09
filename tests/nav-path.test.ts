import { describe, expect, it } from "bun:test";
import {
  compareEnvironments,
  environmentsOf,
  groupEnvironmentsByProject,
  parseNavPath,
  stripProjectPrefix,
} from "@/lib/nav-path";

// next-intl's usePathname returns the path without the locale prefix, which is
// what every caller passes in.
describe("parseNavPath", () => {
  it.each([
    [
      "/CMEM/prod",
      {
        scope: "env",
        projectKey: "CMEM",
        envSlug: "prod",
        section: null,
        logs: false,
      },
    ],
    [
      "/CMEM/prod/services",
      {
        scope: "env",
        projectKey: "CMEM",
        envSlug: "prod",
        section: "services",
        logs: false,
      },
    ],
    [
      "/CMEM/prod/services/db/logs",
      {
        scope: "env",
        projectKey: "CMEM",
        envSlug: "prod",
        section: "services",
        logs: true,
      },
    ],
    [
      "/CMEM/fee-daily-129/mock-time",
      {
        scope: "env",
        projectKey: "CMEM",
        envSlug: "fee-daily-129",
        section: "mock-time",
        logs: false,
      },
    ],
  ])("reads environment path %s", (path, expected) => {
    expect(parseNavPath(path)).toEqual(expected as never);
  });

  it.each([
    ["/CMEM", "overview"],
    ["/CMEM/settings", "settings"],
    ["/CMEM/issues/42", "issue"],
    ["/CMEM/environments/new", "new-environment"],
    ["/CMEM/members", "other"],
    ["/CMEM/milestones", "other"],
    ["/CMEM/new", "other"],
  ])("reads project-level path %s as %s", (path, page) => {
    expect(parseNavPath(path)).toEqual({
      scope: "project",
      projectKey: "CMEM",
      page,
    } as never);
  });

  it.each([
    "/",
    "/projects",
    "/issues",
    "/admin/jira",
    "/servers/new",
    "/account/change-password",
    "/PROJECTS",
    "/ISSUES/12",
    "/C",
    "/cmem/prod",
    "/CMEM/Prod",
  ])("treats %s as outside any project", (path) => {
    expect(parseNavPath(path)).toEqual({ scope: null });
  });
});

describe("compareEnvironments", () => {
  it("orders by kind (dev, qa, sandbox, release, prod, none), then name", () => {
    const envs = [
      { kind: null, name: "Alpha" },
      { kind: "prod", name: "Prod" },
      { kind: "qa", name: "core2 (QA Wella)" },
      { kind: "dev", name: "core3" },
      { kind: "release", name: "Release" },
      { kind: "qa", name: "core (QA Aisha)" },
      { kind: "sandbox", name: "Sandbox" },
    ];
    expect([...envs].sort(compareEnvironments).map((e) => e.name)).toEqual([
      "core3",
      "core (QA Aisha)",
      "core2 (QA Wella)",
      "Sandbox",
      "Release",
      "Prod",
      "Alpha",
    ]);
  });
});

describe("stripProjectPrefix", () => {
  it.each([
    ["CAR Membership P2SK (137)", "CAR Membership", "P2SK (137)"],
    ["car membership - Release", "CAR Membership", "Release"],
    ["CAR Membership", "CAR Membership", "CAR Membership"],
    ["Fee Daily (129)", "CAR Membership", "Fee Daily (129)"],
    ["Anything", "", "Anything"],
  ])("%s under %s -> %s", (env, project, expected) => {
    expect(stripProjectPrefix(env, project)).toBe(expected);
  });
});

const env = (
  id: string,
  projectId: string,
  name: string,
  kind: string | null = null
) => ({ id, projectId, name, kind });

describe("environmentsOf", () => {
  it("keeps only the project's environments, in kind order", () => {
    const envs = [
      env("1", "a", "Release", "release"),
      env("2", "b", "Other"),
      env("3", "a", "Dev", "dev"),
    ];
    expect(environmentsOf(envs, "a").map((e) => e.id)).toEqual(["3", "1"]);
  });

  it("returns an empty list for a project without environments", () => {
    expect(environmentsOf([env("1", "a", "Dev")], "z")).toEqual([]);
  });
});

describe("groupEnvironmentsByProject", () => {
  const projects = [
    { id: "a", name: "CAR Membership" },
    { id: "b", name: "Common Membership" },
    { id: "c", name: "Empty Project" },
  ];

  it("keeps project order, drops empty projects, sorts each group", () => {
    const envs = [
      env("1", "b", "Release", "release"),
      env("2", "a", "Release", "release"),
      env("3", "a", "Fee Daily", "dev"),
    ];
    const groups = groupEnvironmentsByProject(projects, envs);
    expect(groups.map((g) => g.project.id)).toEqual(["a", "b"]);
    expect(groups[0]?.environments.map((e) => e.id)).toEqual(["3", "2"]);
    // Same-named environments stay in their own project's group.
    expect(groups[1]?.environments.map((e) => e.id)).toEqual(["1"]);
  });
});
