import { describe, expect, it } from "vitest";
import {
  assertNotLastAdmin,
  filterUsers,
  isInactive,
  parseUsersTab,
  userStatus,
} from "@/lib/access";

describe("assertNotLastAdmin", () => {
  it("allows demoting an admin when another admin remains", () => {
    expect(assertNotLastAdmin(["a", "b"], "a", "member")).toBe(true);
  });
  it("refuses demoting the last admin", () => {
    expect(assertNotLastAdmin(["a"], "a", "member")).toBe(false);
  });
  it("refuses offboarding (null role) the last admin", () => {
    expect(assertNotLastAdmin(["a"], "a", null)).toBe(false);
  });
  it("allows any change to a non-admin", () => {
    expect(assertNotLastAdmin(["a"], "z", null)).toBe(true);
  });
  it("allows keeping the last admin as admin", () => {
    expect(assertNotLastAdmin(["a"], "a", "admin")).toBe(true);
  });
});

describe("isInactive", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  it("treats never-seen users as inactive", () => {
    expect(isInactive(null, now)).toBe(true);
  });
  it("flags users idle for more than 60 days", () => {
    expect(isInactive(new Date("2026-08-01T00:00:00Z"), now)).toBe(true);
  });
  it("keeps recent users active", () => {
    expect(isInactive(new Date("2026-09-20T00:00:00Z"), now)).toBe(false);
  });
});

describe("userStatus", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  it("reports banned before anything else", () => {
    expect(userStatus({ banned: true, lastActiveAt: null }, now)).toBe(
      "banned"
    );
  });
  it("reports inactive for idle or never-seen users", () => {
    expect(userStatus({ banned: false, lastActiveAt: null }, now)).toBe(
      "inactive"
    );
    expect(
      userStatus({ banned: false, lastActiveAt: "2026-07-01T00:00:00Z" }, now)
    ).toBe("inactive");
  });
  it("reports active for recent users, Date or ISO string", () => {
    expect(
      userStatus(
        { banned: false, lastActiveAt: new Date("2026-10-01T00:00:00Z") },
        now
      )
    ).toBe("active");
    expect(
      userStatus({ banned: false, lastActiveAt: "2026-10-01T00:00:00Z" }, now)
    ).toBe("active");
  });
});

describe("filterUsers", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  const recent = "2026-10-01T00:00:00Z";
  const old = "2026-06-01T00:00:00Z";
  const users = [
    { id: "active", banned: false, lastActiveAt: recent },
    { id: "idle", banned: false, lastActiveAt: old },
    { id: "never", banned: false, lastActiveAt: null },
    { id: "banned-recent", banned: true, lastActiveAt: recent },
    { id: "banned-idle", banned: true, lastActiveAt: old },
  ];
  const ids = (opts: { showBanned: boolean; inactiveOnly: boolean }) =>
    filterUsers(users, { ...opts, now }).map((u) => u.id);

  it("hides banned users by default", () => {
    expect(ids({ showBanned: false, inactiveOnly: false })).toEqual([
      "active",
      "idle",
      "never",
    ]);
  });
  it("shows banned users on request", () => {
    expect(ids({ showBanned: true, inactiveOnly: false })).toEqual(
      users.map((u) => u.id)
    );
  });
  it("keeps only inactive users when asked", () => {
    expect(ids({ showBanned: false, inactiveOnly: true })).toEqual([
      "idle",
      "never",
    ]);
  });
  it("combines both filters", () => {
    expect(ids({ showBanned: true, inactiveOnly: true })).toEqual([
      "idle",
      "never",
      "banned-idle",
    ]);
  });
  it("returns the same row objects, untouched", () => {
    const [first] = filterUsers(users, {
      showBanned: false,
      inactiveOnly: false,
      now,
    });
    expect(first).toBe(users[0]);
  });
});

describe("parseUsersTab", () => {
  const all = ["users", "access", "pending", "expired"] as const;
  it("defaults to users when absent", () => {
    expect(parseUsersTab(null, all)).toBe("users");
    expect(parseUsersTab(undefined, all)).toBe("users");
  });
  it("accepts a visible tab", () => {
    expect(parseUsersTab("access", all)).toBe("access");
    expect(parseUsersTab("expired", all)).toBe("expired");
  });
  it("falls back to users for unknown values", () => {
    expect(parseUsersTab("nope", all)).toBe("users");
    expect(parseUsersTab("", all)).toBe("users");
  });
  it("falls back to users for a tab the viewer can't see", () => {
    expect(parseUsersTab("access", ["users", "pending"])).toBe("users");
  });
});
