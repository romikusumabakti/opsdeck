import { describe, expect, it } from "bun:test";
import {
  canOpenSection,
  compareEnvironments,
  environmentSwitchHref,
  environmentsOf,
  groupEnvironmentsByProject,
  parseNavPath,
  projectSwitchHref,
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

const target = (
  slug: string,
  lastAccessedAt: Date | null,
  hasMailpit = true
) => ({ key: "SUCOR", slug, hasMailpit, lastAccessedAt });

describe("canOpenSection", () => {
  it("needs a connected Mailpit for mail", () => {
    expect(canOpenSection("mail", { hasMailpit: false }, "maintainer")).toBe(
      false
    );
    expect(canOpenSection("mail", { hasMailpit: true }, "maintainer")).toBe(
      true
    );
  });
  it("checks the section permission against the role", () => {
    expect(canOpenSection("settings", { hasMailpit: true }, "viewer")).toBe(
      false
    );
    expect(canOpenSection("settings", { hasMailpit: true }, "maintainer")).toBe(
      true
    );
  });
  it("allows ungated sections for any member", () => {
    expect(canOpenSection("services", { hasMailpit: false }, "viewer")).toBe(
      true
    );
  });
  it("denies everything without a role", () => {
    expect(canOpenSection("settings", { hasMailpit: true }, null)).toBe(false);
  });
});

describe("environmentSwitchHref", () => {
  const dest = { key: "CMEM", slug: "qa", hasMailpit: false };

  it("keeps a parallel section", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/services"), "viewer")
    ).toBe("/CMEM/qa/services");
  });
  it("goes from a log viewer to the target's Services", () => {
    expect(
      environmentSwitchHref(
        dest,
        parseNavPath("/CMEM/prod/services/db/logs"),
        "viewer"
      )
    ).toBe("/CMEM/qa/services");
  });
  it("drops non-parallel sections to the dashboard", () => {
    expect(
      environmentSwitchHref(
        dest,
        parseNavPath("/CMEM/prod/backup-restore"),
        "maintainer"
      )
    ).toBe("/CMEM/qa");
  });
  it("drops mail when the target has no Mailpit", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/mail"), "maintainer")
    ).toBe("/CMEM/qa");
  });
  it("drops a section the role may not open", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/settings"), "viewer")
    ).toBe("/CMEM/qa");
  });
  it("lands on the dashboard from a project-level page", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/settings"), "maintainer")
    ).toBe("/CMEM/qa");
  });
});

describe("projectSwitchHref", () => {
  const environments = [
    target("old", new Date("2026-10-01T00:00:00Z")),
    target("never", null),
    target("latest", new Date("2026-10-08T00:00:00Z")),
  ];

  it("lands on the most recently opened environment, same section", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "viewer",
        from: parseNavPath("/CMEM/prod/services"),
      })
    ).toBe("/SUCOR/latest/services");
  });
  it("uses the landing environment's dashboard for a non-parallel section", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "maintainer",
        from: parseNavPath("/CMEM/prod/backup-restore"),
      })
    ).toBe("/SUCOR/latest");
  });
  it("falls back to the overview when no environment was ever opened", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments: [target("never", null)],
        role: "viewer",
        from: parseNavPath("/CMEM/prod/services"),
      })
    ).toBe("/SUCOR");
  });
  it("falls back to the overview for a project without environments", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments: [],
        role: "viewer",
        from: parseNavPath("/CMEM/prod"),
      })
    ).toBe("/SUCOR");
  });
  it("keeps project settings when permitted", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "maintainer",
        from: parseNavPath("/CMEM/settings"),
      })
    ).toBe("/SUCOR/settings");
  });
  it("drops project settings to the overview when not permitted", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "viewer",
        from: parseNavPath("/CMEM/settings"),
      })
    ).toBe("/SUCOR");
  });
  it.each(["/CMEM", "/CMEM/issues/42", "/CMEM/environments/new"])(
    "goes from %s to the overview",
    (path) => {
      expect(
        projectSwitchHref({
          projectKey: "SUCOR",
          environments,
          role: "maintainer",
          from: parseNavPath(path),
        })
      ).toBe("/SUCOR");
    }
  );
});
