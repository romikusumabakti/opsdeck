import { describe, expect, it } from "bun:test";
import {
  canCreateEnvironment,
  canOrg,
  canProject,
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
      if (r === "viewer" || r === "maintainer") continue;
      expect(normalizeProjectRole(r)).toBeNull();
    }
  });
});

describe("implicitProjectRole", () => {
  it("maps org roles to their implicit project role", () => {
    expect(implicitProjectRole("admin")).toBe("maintainer");
    expect(implicitProjectRole("infra")).toBe("maintainer");
    expect(implicitProjectRole("observer")).toBe("viewer");
    expect(implicitProjectRole("member")).toBeNull();
  });
});

describe("effectiveProjectRole", () => {
  const cases: [OrgRole, ProjectRole | null, ProjectRole | null][] = [
    ["member", null, null],
    ["member", "viewer", "viewer"],
    ["member", "contributor", "contributor"],
    ["member", "maintainer", "maintainer"],
    ["observer", null, "viewer"],
    ["observer", "contributor", "contributor"],
    ["infra", null, "maintainer"],
    ["infra", "viewer", "maintainer"],
    ["admin", null, "maintainer"],
    ["admin", "contributor", "maintainer"],
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
  ["project", "read", { viewer: true, contributor: true, maintainer: true }],
  ["service", "logs", { viewer: true, contributor: true, maintainer: true }],
  ["issue", "write", { viewer: false, contributor: true, maintainer: true }],
  ["issue", "delete", { viewer: false, contributor: false, maintainer: true }],
  ["mail", "read", { viewer: false, contributor: true, maintainer: true }],
  ["mail", "delete", { viewer: false, contributor: true, maintainer: true }],
  ["clock", "control", { viewer: false, contributor: true, maintainer: true }],
  ["database", "backup", { viewer: false, contributor: true, maintainer: true }],
  ["database", "restore", { viewer: false, contributor: true, maintainer: true }],
  ["database", "create", { viewer: false, contributor: false, maintainer: true }],
  ["database", "drop", { viewer: false, contributor: false, maintainer: true }],
  ["database", "rename", { viewer: false, contributor: false, maintainer: true }],
  ["service", "control", { viewer: false, contributor: false, maintainer: true }],
  ["environment", "create", { viewer: false, contributor: false, maintainer: true }],
  ["environment", "update", { viewer: false, contributor: false, maintainer: true }],
  ["environment", "delete", { viewer: false, contributor: false, maintainer: true }],
  ["member", "manage", { viewer: false, contributor: false, maintainer: true }],
  ["run", "acknowledge", { viewer: false, contributor: true, maintainer: true }],
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

describe("canCreateEnvironment", () => {
  it("needs environment:create on the project and org server:manage", () => {
    expect(canCreateEnvironment("admin", "maintainer")).toBe(true);
    expect(canCreateEnvironment("infra", "maintainer")).toBe(true);
  });
  it("denies a maintainer whose org role lacks server:manage", () => {
    for (const org of ["member", "observer", "Admin", null]) {
      expect(canCreateEnvironment(org, "maintainer")).toBe(false);
    }
  });
  it("denies server:manage holders without environment:create", () => {
    expect(canCreateEnvironment("infra", "contributor")).toBe(false);
    expect(canCreateEnvironment("admin", null)).toBe(false);
  });
});
