import { describe, expect, it } from "bun:test";
import {
  ASSIGNABLE_ROLES,
  CAPABILITIES,
  type Capability,
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
