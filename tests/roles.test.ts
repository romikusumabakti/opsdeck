import { describe, expect, it } from "bun:test";
import {
  ASSIGNABLE_ROLES,
  CAPABILITIES,
  type Capability,
  effectiveRole,
  higherRole,
  isAssignableRole,
  normalizeRole,
  ROLE_ADMIN,
  ROLE_MAINTAINER,
  ROLE_MEMBER,
  ROLE_RANK,
  ROLE_VIEWER,
  roleHasCapability,
  roleRank,
  type UserRole,
} from "@/lib/roles";

// The capability ladder is the app's authorization boundary: every server
// action and every API route resolves through roleHasCapability, and the UI
// gates buttons on the same functions. These tests pin the ladder itself —
// the database lookup around it lives in lib/auth-session.

// Values that can realistically reach these helpers from a stale/legacy row,
// a hand-edited database, or a forged payload. All must floor to viewer.
const JUNK_ROLES = [
  null,
  undefined,
  "",
  "owner",
  "superadmin",
  "Admin",
  "ADMIN",
  "admin ",
  " admin",
  "root",
  "__proto__",
  "constructor",
  "toString",
];

describe("ROLE_RANK", () => {
  it("orders roles viewer < member < maintainer < admin", () => {
    expect(ROLE_RANK[ROLE_VIEWER]).toBeLessThan(ROLE_RANK[ROLE_MEMBER]);
    expect(ROLE_RANK[ROLE_MEMBER]).toBeLessThan(ROLE_RANK[ROLE_MAINTAINER]);
    expect(ROLE_RANK[ROLE_MAINTAINER]).toBeLessThan(ROLE_RANK[ROLE_ADMIN]);
  });

  it("ranks every assignable role, and ranks nothing else", () => {
    expect(Object.keys(ROLE_RANK).sort()).toEqual([...ASSIGNABLE_ROLES].sort());
  });
});

describe("roleRank", () => {
  it("returns the declared rank for each real role", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(roleRank(role)).toBe(ROLE_RANK[role]);
    }
  });

  it.each(JUNK_ROLES)("floors %p to viewer's rank", (role) => {
    expect(roleRank(role)).toBe(ROLE_RANK[ROLE_VIEWER]);
  });
});

describe("isAssignableRole", () => {
  it("accepts every role an admin may assign", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(isAssignableRole(role)).toBe(true);
    }
  });

  it.each(JUNK_ROLES.filter((r) => typeof r === "string"))(
    "rejects %p",
    (role) => {
      expect(isAssignableRole(role)).toBe(false);
    }
  );
});

describe("normalizeRole", () => {
  it("passes real roles through unchanged", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(normalizeRole(role)).toBe(role);
    }
  });

  it.each(JUNK_ROLES)("floors %p to viewer", (role) => {
    expect(normalizeRole(role)).toBe(ROLE_VIEWER);
  });
});

describe("higherRole", () => {
  it("returns the higher-ranked of two real roles, either way round", () => {
    for (const a of ASSIGNABLE_ROLES) {
      for (const b of ASSIGNABLE_ROLES) {
        const expected = ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
        expect(higherRole(a, b)).toBe(expected);
        // Commutative by rank: argument order must not change the outcome.
        expect(ROLE_RANK[higherRole(b, a)]).toBe(ROLE_RANK[expected]);
      }
    }
  });

  it("returns the same role when both sides match", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(higherRole(role, role)).toBe(role);
    }
  });

  it.each(JUNK_ROLES)(
    "never lets a junk membership role (%p) raise a global role",
    (junk) => {
      for (const global of ASSIGNABLE_ROLES) {
        expect(higherRole(junk, global)).toBe(global);
      }
    }
  );

  it.each(JUNK_ROLES)(
    "never lets a junk global role (%p) lower a membership role",
    (junk) => {
      for (const membership of ASSIGNABLE_ROLES) {
        expect(higherRole(membership, junk)).toBe(membership);
      }
    }
  );

  it("floors to viewer when neither side is a real role", () => {
    expect(higherRole("owner", null)).toBe(ROLE_VIEWER);
    expect(higherRole(undefined, undefined)).toBe(ROLE_VIEWER);
  });

  // The whole point of the helper: project membership can only ever raise a
  // user's reach, never cut it. A viewer invited as maintainer on one project
  // gets maintainer there; an admin added as viewer stays an admin.
  it("only ever raises, never lowers", () => {
    expect(higherRole(ROLE_MAINTAINER, ROLE_VIEWER)).toBe(ROLE_MAINTAINER);
    expect(higherRole(ROLE_VIEWER, ROLE_ADMIN)).toBe(ROLE_ADMIN);
  });
});

// The rule lib/auth-session applies once it has both roles out of the database.
// The lookups around it (environment → project, then the membership row) are
// not covered here — they are two indexed reads with no branching worth mocking
// drizzle for. What IS covered is every way the two role values combine.
describe("effectiveRole", () => {
  it("returns the global role when there is no membership", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(effectiveRole(role, null)).toBe(role);
      expect(effectiveRole(role, undefined)).toBe(role);
      expect(effectiveRole(role, "")).toBe(role);
    }
  });

  it("raises the global role to a higher membership role", () => {
    expect(effectiveRole(ROLE_VIEWER, ROLE_MAINTAINER)).toBe(ROLE_MAINTAINER);
    expect(effectiveRole(ROLE_MEMBER, ROLE_ADMIN)).toBe(ROLE_ADMIN);
  });

  it("never lets a lower membership role cut the global role", () => {
    // An admin added to a project as a viewer is still an admin there.
    expect(effectiveRole(ROLE_ADMIN, ROLE_VIEWER)).toBe(ROLE_ADMIN);
    expect(effectiveRole(ROLE_MAINTAINER, ROLE_MEMBER)).toBe(ROLE_MAINTAINER);
  });

  it("resolves every global × membership pair to the higher rank", () => {
    for (const global of ASSIGNABLE_ROLES) {
      for (const membership of ASSIGNABLE_ROLES) {
        const expected =
          ROLE_RANK[global] >= ROLE_RANK[membership] ? global : membership;
        expect(effectiveRole(global, membership)).toBe(expected);
      }
    }
  });

  // ABSENT and UNKNOWN are deliberately different. A user row predating the
  // admin plugin's defaultRole has no role at all and has always behaved as a
  // member; flooring those to viewer would silently revoke edit rights from
  // every pre-existing account. Any other unrecognised string is a stale or
  // forged value and must fail closed.
  describe("the legacy no-role default", () => {
    it("treats an absent global role as member, not viewer", () => {
      expect(effectiveRole(null, null)).toBe(ROLE_MEMBER);
      expect(effectiveRole(undefined, null)).toBe(ROLE_MEMBER);
    });

    it("lets a legacy user keep issue and KB edit rights", () => {
      const role = effectiveRole(null, null);
      expect(roleHasCapability(role, "issue.edit")).toBe(true);
      expect(roleHasCapability(role, "kb.edit")).toBe(true);
    });

    it("still denies a legacy user ops and admin", () => {
      const role = effectiveRole(null, null);
      expect(roleHasCapability(role, "ops.destructive")).toBe(false);
      expect(roleHasCapability(role, "admin")).toBe(false);
    });

    it("floors an unrecognised global role to viewer, not member", () => {
      for (const junk of JUNK_ROLES.filter(
        (r) => r !== null && r !== undefined
      )) {
        expect(effectiveRole(junk, null)).toBe(ROLE_VIEWER);
      }
    });

    it("does not apply the default when a membership already raises the user", () => {
      expect(effectiveRole(null, ROLE_ADMIN)).toBe(ROLE_ADMIN);
      // …and never lets the default lower a membership either.
      expect(effectiveRole(null, ROLE_VIEWER)).toBe(ROLE_MEMBER);
    });
  });

  it.each(JUNK_ROLES)(
    "never lets a junk membership role (%p) raise a real global role",
    (junk) => {
      for (const global of ASSIGNABLE_ROLES) {
        expect(effectiveRole(global, junk)).toBe(global);
      }
    }
  );

  it("never grants admin unless one of the two roles is admin", () => {
    const inputs = [...ASSIGNABLE_ROLES, ...JUNK_ROLES];
    for (const global of inputs) {
      for (const membership of inputs) {
        const isAdmin = effectiveRole(global, membership) === ROLE_ADMIN;
        expect(isAdmin).toBe(
          global === ROLE_ADMIN || membership === ROLE_ADMIN
        );
      }
    }
  });
});

describe("roleHasCapability", () => {
  // The full matrix, written out rather than derived from CAPABILITY_MIN_ROLE
  // (which is private) — a test that recomputes the table it checks would pass
  // no matter how the table changed.
  const MATRIX: Record<UserRole, Record<Capability, boolean>> = {
    [ROLE_VIEWER]: {
      read: true,
      "issue.edit": false,
      "kb.edit": false,
      "ops.destructive": false,
      admin: false,
    },
    [ROLE_MEMBER]: {
      read: true,
      "issue.edit": true,
      "kb.edit": true,
      "ops.destructive": false,
      admin: false,
    },
    [ROLE_MAINTAINER]: {
      read: true,
      "issue.edit": true,
      "kb.edit": true,
      "ops.destructive": true,
      admin: false,
    },
    [ROLE_ADMIN]: {
      read: true,
      "issue.edit": true,
      "kb.edit": true,
      "ops.destructive": true,
      admin: true,
    },
  };

  it("covers every role and capability the app declares", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ASSIGNABLE_ROLES].sort());
    for (const role of ASSIGNABLE_ROLES) {
      expect(Object.keys(MATRIX[role]).sort()).toEqual(
        [...CAPABILITIES].sort()
      );
    }
  });

  it("grants exactly the matrix, and nothing beyond it", () => {
    for (const role of ASSIGNABLE_ROLES) {
      for (const cap of CAPABILITIES) {
        expect([role, cap, roleHasCapability(role, cap)]).toEqual([
          role,
          cap,
          MATRIX[role][cap],
        ]);
      }
    }
  });

  it("is monotonic: a higher role never loses a lower role's capability", () => {
    const ladder = [...ASSIGNABLE_ROLES].sort(
      (a, b) => ROLE_RANK[a] - ROLE_RANK[b]
    );
    for (const cap of CAPABILITIES) {
      let granted = false;
      for (const role of ladder) {
        const has = roleHasCapability(role, cap);
        if (granted) {
          expect(has).toBe(true);
        }
        granted ||= has;
      }
      // Every capability is reachable by someone — an unreachable one would be
      // dead config that silently disables a feature.
      expect(granted).toBe(true);
    }
  });

  it.each(JUNK_ROLES)(
    "grants %p read only — never a write capability",
    (role) => {
      expect(roleHasCapability(role, "read")).toBe(true);
      expect(roleHasCapability(role, "issue.edit")).toBe(false);
      expect(roleHasCapability(role, "kb.edit")).toBe(false);
      expect(roleHasCapability(role, "ops.destructive")).toBe(false);
      expect(roleHasCapability(role, "admin")).toBe(false);
    }
  );

  it("reserves admin for the admin role alone", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(roleHasCapability(role, "admin")).toBe(role === ROLE_ADMIN);
    }
  });

  // requireAdmin() is documented as a thin wrapper over
  // requireCapability("admin"); if that stopped holding, every admin-only
  // action would silently widen.
  it("keeps requireAdmin equivalent to the admin capability", () => {
    for (const role of [...ASSIGNABLE_ROLES, ...JUNK_ROLES]) {
      expect(roleHasCapability(role, "admin")).toBe(role === ROLE_ADMIN);
    }
  });
});
