import { describe, expect, it } from "vitest";
import {
  canCreateEnvironment,
  canCreateProject,
  canOrg,
  canProject,
  canRegisterApp,
  effectiveProjectRole,
  implicitProjectRole,
  normalizeOrgRole,
  normalizeProjectRole,
  ORG_ROLES,
  type OrgRole,
  PROJECT_ROLES,
  type ProjectRole,
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
];

describe("normalizeOrgRole", () => {
  it("keeps every real org role", () => {
    for (const r of ORG_ROLES) expect(normalizeOrgRole(r)).toBe(r);
  });
  it("floors junk and legacy values to member", () => {
    for (const r of JUNK_ROLES) expect(normalizeOrgRole(r)).toBe("member");
  });
});

describe("normalizeProjectRole", () => {
  it("keeps every real project role", () => {
    for (const r of PROJECT_ROLES) expect(normalizeProjectRole(r)).toBe(r);
  });
  it("treats junk and the removed `admin`/`member` values as no membership", () => {
    for (const r of [...JUNK_ROLES, "admin", "member"]) {
      if (r === "viewer" || r === "engineer") continue;
      expect(normalizeProjectRole(r)).toBeNull();
    }
  });
});

describe("implicitProjectRole", () => {
  it("maps org roles to their implicit project role", () => {
    expect(implicitProjectRole("admin")).toBe("engineer");
    expect(implicitProjectRole("infra")).toBe("engineer");
    expect(implicitProjectRole("observer")).toBe("viewer");
    expect(implicitProjectRole("member")).toBeNull();
  });
});

describe("effectiveProjectRole", () => {
  const cases: [OrgRole, ProjectRole | null, ProjectRole | null][] = [
    ["member", null, null],
    ["member", "viewer", "viewer"],
    ["member", "qa", "qa"],
    ["member", "engineer", "engineer"],
    ["observer", null, "viewer"],
    ["observer", "qa", "qa"],
    ["infra", null, "engineer"],
    ["infra", "viewer", "engineer"],
    ["admin", null, "engineer"],
    ["admin", "qa", "engineer"],
  ];
  for (const [org, membership, expected] of cases) {
    it(`${org} + ${membership ?? "none"} → ${expected ?? "none"}`, () => {
      expect(effectiveProjectRole(org, membership)).toBe(expected);
    });
  }
  it("never lets a junk org role see a project without membership", () => {
    for (const r of JUNK_ROLES)
      expect(effectiveProjectRole(r, null)).toBeNull();
  });
});

// The spec's org matrix, verbatim. One row per statement, one column per role.
// biome-ignore format: kept as a one-row-per-statement table to mirror the spec
const ORG_MATRIX: [string, string, Record<OrgRole, boolean>][] = [
  ["user", "list", { admin: true, infra: false, observer: true, member: false }],
  ["user", "invite", { admin: true, infra: false, observer: false, member: false }],
  ["user", "set-role", { admin: true, infra: false, observer: false, member: false }],
  ["user", "offboard", { admin: true, infra: false, observer: false, member: false }],
  ["project", "create", { admin: true, infra: false, observer: false, member: false }],
  ["project", "delete", { admin: true, infra: false, observer: false, member: false }],
  ["server", "read", { admin: true, infra: true, observer: true, member: false }],
  ["server", "manage", { admin: true, infra: true, observer: false, member: false }],
  ["server", "terminal", { admin: true, infra: true, observer: false, member: false }],
  ["server", "files", { admin: true, infra: true, observer: false, member: false }],
  ["storage", "read", { admin: true, infra: true, observer: true, member: false }],
  ["storage", "manage", { admin: true, infra: true, observer: false, member: false }],
  ["storage", "files", { admin: true, infra: true, observer: false, member: false }],
  ["tunnel", "read", { admin: true, infra: true, observer: true, member: false }],
  ["tunnel", "manage", { admin: true, infra: true, observer: false, member: false }],
  ["integration", "manage", { admin: true, infra: false, observer: false, member: false }],
  ["knowledge", "read", { admin: true, infra: true, observer: true, member: true }],
  ["knowledge", "write", { admin: true, infra: true, observer: false, member: true }],
  ["knowledge", "manage", { admin: true, infra: false, observer: false, member: false }],
  ["audit", "read", { admin: true, infra: true, observer: true, member: false }],
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
  it("denies every statement to junk roles except what member has", () => {
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
  ["service", "control", { viewer: false, qa: true, engineer: true }],
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
    for (const org of ["member", "observer", "Admin", null]) {
      expect(canCreateEnvironment(org, "engineer")).toBe(false);
    }
  });
  it("denies server:manage holders without environment:create", () => {
    expect(canCreateEnvironment("infra", "qa")).toBe(false);
    expect(canCreateEnvironment("admin", null)).toBe(false);
  });
});

describe("canRegisterApp", () => {
  it("admins may register apps without any project membership", () => {
    expect(canRegisterApp("admin", [])).toBe(true);
  });
  it("infra counts as maintainer through its implicit project role", () => {
    expect(canRegisterApp("infra", [])).toBe(true);
  });
  it("a member who maintains one project may register apps", () => {
    expect(canRegisterApp("member", ["viewer", "engineer"])).toBe(true);
  });
  it("a member with only contributor or viewer roles may not", () => {
    expect(canRegisterApp("member", ["qa", "viewer"])).toBe(false);
    expect(canRegisterApp("member", [])).toBe(false);
  });
  it("observers and junk org roles need a maintainer membership", () => {
    expect(canRegisterApp("observer", [])).toBe(false);
    expect(canRegisterApp("observer", ["engineer"])).toBe(true);
    for (const r of JUNK_ROLES) expect(canRegisterApp(r, [])).toBe(false);
  });
});

describe("QA and engineer behaviour", () => {
  it("qa can restart services", () => {
    expect(canProject("qa", { service: ["control"] })).toBe(true);
  });

  it("qa cannot create environments", () => {
    expect(canProject("qa", { environment: ["create"] })).toBe(false);
  });

  it("engineer can create a project", () => {
    expect(canCreateProject("member", ["engineer"])).toBe(true);
    expect(canCreateProject("member", ["qa"])).toBe(false);
    expect(canCreateProject("member", [])).toBe(false);
    expect(canCreateProject("admin", [])).toBe(true);
    expect(canCreateProject("infra", [])).toBe(true);
    expect(canCreateProject("observer", ["viewer"])).toBe(false);
    expect(canCreateProject("observer", ["engineer"])).toBe(true);
  });
});
