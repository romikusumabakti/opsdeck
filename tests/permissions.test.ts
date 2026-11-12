import { describe, expect, it } from "vitest";
import {
  canCreateEnvironment,
  canCreateProject,
  canOrg,
  canOrgAccess,
  canOrgAccessTarget,
  canProject,
  canRegisterApp,
  effectiveProjectRole,
  normalizeOrgRole,
  ORG_ROLES,
  type OrgRole,
  PROJECT_ROLES,
  type ProjectRole,
  projectRoleForOrgRole,
  seesAllProjects,
} from "@/lib/permissions";

// Values that can reach the helpers from a legacy row, a hand-edited DB or a
// forged payload. None may ever grant more than the floor.
const JUNK_ROLES = [
  null,
  undefined,
  "",
  "owner",
  "superadmin",
  "Admin",
  "ADMIN",
  "admin ",
  "root",
  "__proto__",
  "constructor",
  "toString",
  "viewer", // old org role
  "maintainer", // old org role
  "member", // old org role, replaced by engineer and qa
];

describe("normalizeOrgRole", () => {
  it("keeps the five roles", () => {
    for (const r of ORG_ROLES) expect(normalizeOrgRole(r)).toBe(r);
  });
  it("floors member, legacy and junk roles to qa", () => {
    for (const r of [
      "member",
      "viewer",
      "maintainer",
      "toString",
      "",
      null,
      undefined,
    ])
      expect(normalizeOrgRole(r)).toBe("qa");
    for (const r of JUNK_ROLES) expect(normalizeOrgRole(r)).toBe("qa");
  });
});

describe("projectRoleForOrgRole", () => {
  it.each([
    ["admin", "engineer"],
    ["infra", "engineer"],
    ["engineer", "engineer"],
    ["qa", "qa"],
    ["observer", "viewer"],
    ["member", "qa"],
    ["toString", "qa"],
  ])("%s → %s", (org, set) => expect(projectRoleForOrgRole(org)).toBe(set));
});

describe("effectiveProjectRole", () => {
  it.each([
    ["admin", false, "engineer"],
    ["admin", true, "engineer"],
    ["infra", false, "engineer"],
    ["observer", false, "viewer"],
    ["observer", true, "viewer"],
    ["engineer", true, "engineer"],
    ["engineer", false, null],
    ["qa", true, "qa"],
    ["qa", false, null],
    ["member", true, "qa"],
    ["member", false, null],
  ] as const)("%s, member %s → %s", (org, isMember, expected) =>
    expect(effectiveProjectRole(org, isMember)).toBe(expected)
  );
  it("never lets a junk org role see a project without membership", () => {
    for (const r of JUNK_ROLES)
      expect(effectiveProjectRole(r, false)).toBeNull();
  });
});

describe("seesAllProjects", () => {
  it.each([
    ["admin", true],
    ["infra", true],
    ["observer", true],
    ["engineer", false],
    ["qa", false],
    ["member", false],
  ] as const)("%s → %s", (org, expected) =>
    expect(seesAllProjects(org)).toBe(expected)
  );
});

// The spec's org matrix, verbatim. One row per statement, one column per role.
// biome-ignore format: kept as a one-row-per-statement table to mirror the spec
const ORG_MATRIX: [string, string, Record<OrgRole, boolean>][] = [
  ["user", "list", { admin: true, infra: false, observer: true, engineer: false, qa: false }],
  ["user", "invite", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["user", "set-role", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["user", "offboard", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["project", "create", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["project", "delete", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["server", "read", { admin: true, infra: true, observer: true, engineer: false, qa: false }],
  ["server", "manage", { admin: true, infra: true, observer: false, engineer: false, qa: false }],
  ["server", "terminal", { admin: true, infra: true, observer: false, engineer: false, qa: false }],
  ["server", "files", { admin: true, infra: true, observer: false, engineer: false, qa: false }],
  ["storage", "read", { admin: true, infra: true, observer: true, engineer: false, qa: false }],
  ["storage", "manage", { admin: true, infra: true, observer: false, engineer: false, qa: false }],
  ["storage", "files", { admin: true, infra: true, observer: false, engineer: false, qa: false }],
  ["tunnel", "read", { admin: true, infra: true, observer: true, engineer: false, qa: false }],
  ["tunnel", "manage", { admin: true, infra: true, observer: false, engineer: false, qa: false }],
  ["integration", "manage", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["knowledge", "read", { admin: true, infra: true, observer: true, engineer: true, qa: true }],
  ["knowledge", "write", { admin: true, infra: true, observer: false, engineer: true, qa: true }],
  ["knowledge", "manage", { admin: true, infra: false, observer: false, engineer: false, qa: false }],
  ["audit", "read", { admin: true, infra: true, observer: true, engineer: false, qa: false }],
];

describe("canOrg matrix", () => {
  for (const [resource, action, expected] of ORG_MATRIX) {
    for (const role of ORG_ROLES) {
      it(`${role} ${expected[role] ? "can" : "cannot"} ${resource}:${action}`, () => {
        expect(canOrg(role, { [resource]: [action] } as never)).toBe(
          expected[role]
        );
      });
    }
  }
  it("denies every statement to junk roles except what qa has", () => {
    for (const r of JUNK_ROLES) {
      expect(canOrg(r, { user: ["invite"] })).toBe(false);
      expect(canOrg(r, { server: ["terminal"] })).toBe(false);
      expect(canOrg(r, { knowledge: ["read"] })).toBe(true);
    }
  });
});

// biome-ignore format: kept as a one-row-per-statement table to mirror the spec
const PROJECT_MATRIX: [string, string, Record<ProjectRole, boolean>][] = [
  ["project", "read", { viewer: true, qa: true, engineer: true }],
  ["service", "logs", { viewer: true, qa: true, engineer: true }],
  ["issue", "write", { viewer: false, qa: true, engineer: true }],
  ["issue", "delete", { viewer: false, qa: false, engineer: true }],
  ["mail", "read", { viewer: false, qa: true, engineer: true }],
  ["mail", "delete", { viewer: false, qa: true, engineer: true }],
  ["clock", "control", { viewer: false, qa: true, engineer: true }],
  ["database", "backup", { viewer: false, qa: true, engineer: true }],
  ["database", "restore", { viewer: false, qa: true, engineer: true }],
  ["database", "create", { viewer: false, qa: false, engineer: true }],
  ["database", "drop", { viewer: false, qa: false, engineer: true }],
  ["database", "rename", { viewer: false, qa: false, engineer: true }],
  ["service", "restart", { viewer: false, qa: true, engineer: true }],
  ["service", "control", { viewer: false, qa: false, engineer: true }],
  ["environment", "create", { viewer: false, qa: false, engineer: true }],
  ["environment", "update", { viewer: false, qa: false, engineer: true }],
  ["environment", "delete", { viewer: false, qa: false, engineer: true }],
  ["member", "manage", { viewer: false, qa: false, engineer: true }],
  ["run", "acknowledge", { viewer: false, qa: true, engineer: true }],
  ["deploy", "view", { viewer: true, qa: true, engineer: true }],
  ["deploy", "run", { viewer: false, qa: false, engineer: true }],
  ["deploy", "rollback", { viewer: false, qa: false, engineer: true }],
  ["deploy", "configure", { viewer: false, qa: false, engineer: true }],
];

describe("canProject matrix", () => {
  for (const [resource, action, expected] of PROJECT_MATRIX) {
    for (const role of PROJECT_ROLES) {
      it(`${role} ${expected[role] ? "can" : "cannot"} ${resource}:${action}`, () => {
        expect(canProject(role, { [resource]: [action] } as never)).toBe(
          expected[role]
        );
      });
    }
  }
  it("denies everything to no role", () => {
    expect(canProject(null, { project: ["read"] })).toBe(false);
  });
});

describe("deploy permissions", () => {
  it("only maintainers may run, roll back and configure deploys", () => {
    for (const p of ["run", "rollback", "configure"] as const) {
      expect(canProject("engineer", { deploy: [p] })).toBe(true);
      expect(canProject("qa", { deploy: [p] })).toBe(false);
      expect(canProject("viewer", { deploy: [p] })).toBe(false);
    }
    expect(canProject("viewer", { deploy: ["view"] })).toBe(true);
  });
});

describe("canCreateEnvironment", () => {
  it("needs environment:create on the project and org server:manage", () => {
    expect(canCreateEnvironment("admin", "engineer")).toBe(true);
    expect(canCreateEnvironment("infra", "engineer")).toBe(true);
  });
  it("denies a maintainer whose org role lacks server:manage", () => {
    for (const org of ["engineer", "qa", "member", "observer", "Admin", null]) {
      expect(canCreateEnvironment(org, "engineer")).toBe(false);
    }
  });
  it("denies server:manage holders without environment:create", () => {
    expect(canCreateEnvironment("infra", "qa")).toBe(false);
    expect(canCreateEnvironment("admin", null)).toBe(false);
  });
});

describe("QA and engineer behaviour", () => {
  it("qa can restart services", () => {
    expect(canProject("qa", { service: ["restart"] })).toBe(true);
  });

  it("qa cannot start or stop services", () => {
    expect(canProject("qa", { service: ["control"] })).toBe(false);
  });

  it("engineer can restart, start and stop services", () => {
    expect(canProject("engineer", { service: ["restart"] })).toBe(true);
    expect(canProject("engineer", { service: ["control"] })).toBe(true);
  });

  it("qa cannot create environments", () => {
    expect(canProject("qa", { environment: ["create"] })).toBe(false);
  });
});

describe("canOrg for the new roles", () => {
  it("gives engineer and qa exactly member's old grant", () => {
    for (const r of ["engineer", "qa"]) {
      expect(canOrg(r, { knowledge: ["read", "write"] })).toBe(true);
      expect(canOrg(r, { knowledge: ["manage"] })).toBe(false);
      expect(canOrg(r, { server: ["read"] })).toBe(false);
    }
  });
});

describe("canOrgAccess", () => {
  const grant = [
    { server: ["read"] },
    { server: ["terminal"] },
    { server: ["files"] },
    { storage: ["read"] },
    { storage: ["files"] },
    { server: ["read"], storage: ["read"] },
  ] as const;
  const beyond = [
    { server: ["manage"] },
    { storage: ["manage"] },
    { tunnel: ["read"] },
    { server: ["read", "manage"] },
    { audit: ["read"] },
  ] as const;
  it("gives engineer the grant from the role alone", () => {
    for (const p of grant) expect(canOrgAccess("engineer", p)).toBe(true);
    for (const p of beyond) expect(canOrgAccess("engineer", p)).toBe(false);
  });
  it("gives qa, member and junk roles no grant", () => {
    for (const r of ["qa", "member", "toString"])
      expect(canOrgAccess(r, { server: ["read"] })).toBe(false);
  });
  it("leaves observer and infra on their org role", () => {
    expect(canOrgAccess("observer", { server: ["read"] })).toBe(true);
    expect(canOrgAccess("observer", { server: ["terminal"] })).toBe(false);
    expect(canOrgAccess("infra", { server: ["manage"] })).toBe(true);
  });
});

describe("canOrgAccessTarget", () => {
  it.each([
    ["engineer", { server: ["terminal"] }, false, true],
    ["engineer", { server: ["terminal"] }, true, false],
    ["engineer", { storage: ["files"] }, true, false],
    ["infra", { server: ["terminal"] }, true, true],
    ["admin", { storage: ["files"] }, true, true],
    ["qa", { server: ["read"] }, false, false],
  ] as const)("%s %j restricted %s → %s", (org, perms, restricted, expected) =>
    expect(canOrgAccessTarget(org, perms, restricted)).toBe(expected)
  );
});

describe("canCreateProject and canRegisterApp", () => {
  it.each([
    ["admin", true],
    ["infra", true],
    ["engineer", true],
    ["qa", false],
    ["observer", false],
    ["member", false],
    ["toString", false],
  ] as const)("%s → %s", (org, expected) => {
    expect(canCreateProject(org)).toBe(expected);
    expect(canRegisterApp(org)).toBe(expected);
  });
});
