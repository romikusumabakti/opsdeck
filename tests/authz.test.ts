import { describe, expect, it } from "vitest";
import {
  checkProjectAccess,
  type ProjectAccess,
  resolveProjectAccess,
} from "@/lib/authz";

const ALL = ["p1", "p2", "p3"];

describe("resolveProjectAccess", () => {
  it("gives an engineer exactly their memberships, at the engineer set", () =>
    expect(resolveProjectAccess("engineer", ALL, ["p1", "p3"])).toEqual({
      all: false,
      roles: { p1: "engineer", p3: "engineer" },
    }));
  it("gives qa its memberships at the qa set, and nothing without one", () => {
    expect(resolveProjectAccess("qa", ALL, ["p2"])).toEqual({
      all: false,
      roles: { p2: "qa" },
    });
    expect(resolveProjectAccess("qa", ALL, [])).toEqual({
      all: false,
      roles: {},
    });
  });
  it("gives an engineer with no memberships no project", () =>
    expect(resolveProjectAccess("engineer", ALL, [])).toEqual({
      all: false,
      roles: {},
    }));
  it("gives observer every project as viewer; a membership does not raise it", () =>
    expect(resolveProjectAccess("observer", ALL, ["p2"])).toEqual({
      all: true,
      roles: { p1: "viewer", p2: "viewer", p3: "viewer" },
    }));
  it("gives admin and infra every project as engineer", () => {
    for (const org of ["admin", "infra"])
      expect(resolveProjectAccess(org, ALL, ["p1"])).toEqual({
        all: true,
        roles: { p1: "engineer", p2: "engineer", p3: "engineer" },
      });
  });
  it("floors member and junk roles to qa on their memberships", () => {
    expect(resolveProjectAccess("member", ALL, ["p1"])).toEqual({
      all: false,
      roles: { p1: "qa" },
    });
    expect(resolveProjectAccess("maintainer", ALL, [])).toEqual({
      all: false,
      roles: {},
    });
  });
});

describe("checkProjectAccess", () => {
  // One org role gives one set everywhere, so a mixed set is built by hand.
  const access: ProjectAccess = {
    all: false,
    roles: { p1: "engineer", p2: "qa" },
  };

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
