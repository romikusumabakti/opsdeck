import { describe, expect, it } from "bun:test";
import { checkProjectAccess, resolveProjectAccess } from "@/lib/authz";

const ALL = ["p1", "p2", "p3"];

describe("resolveProjectAccess", () => {
  it("gives a member with no memberships nothing", () => {
    expect(resolveProjectAccess("member", ALL, [])).toEqual({
      all: false,
      roles: {},
    });
  });

  it("gives a member exactly their memberships", () => {
    expect(
      resolveProjectAccess("member", ALL, [
        { projectId: "p1", role: "contributor" },
        { projectId: "p3", role: "viewer" },
      ])
    ).toEqual({ all: false, roles: { p1: "contributor", p3: "viewer" } });
  });

  it("drops memberships carrying an unknown role", () => {
    expect(
      resolveProjectAccess("member", ALL, [{ projectId: "p1", role: "admin" }])
    ).toEqual({ all: false, roles: {} });
  });

  it("gives observer every project as viewer, raised by membership", () => {
    expect(
      resolveProjectAccess("observer", ALL, [
        { projectId: "p2", role: "maintainer" },
      ])
    ).toEqual({
      all: true,
      roles: { p1: "viewer", p2: "maintainer", p3: "viewer" },
    });
  });

  it("gives infra and admin every project as maintainer", () => {
    for (const org of ["infra", "admin"]) {
      expect(resolveProjectAccess(org, ALL, [])).toEqual({
        all: true,
        roles: { p1: "maintainer", p2: "maintainer", p3: "maintainer" },
      });
    }
  });

  it("treats a legacy/unknown org role as member", () => {
    expect(resolveProjectAccess("maintainer", ALL, [])).toEqual({
      all: false,
      roles: {},
    });
  });
});

describe("checkProjectAccess", () => {
  const access = resolveProjectAccess("member", ALL, [
    { projectId: "p1", role: "maintainer" },
    { projectId: "p2", role: "contributor" },
  ]);

  it("passes when every project grants the permission", () => {
    expect(checkProjectAccess(access, ["p1", "p2"], { issue: ["write"] })).toBe(
      true
    );
  });

  it("refuses the whole set when one project lacks it", () => {
    expect(
      checkProjectAccess(access, ["p1", "p2"], { issue: ["delete"] })
    ).toBe(false);
  });

  it("refuses a set containing an invisible project", () => {
    expect(checkProjectAccess(access, ["p1", "p3"], { issue: ["write"] })).toBe(
      false
    );
  });

  it("passes an empty set (nothing to authorize)", () => {
    expect(checkProjectAccess(access, [], { issue: ["delete"] })).toBe(true);
  });
});
