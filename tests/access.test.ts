import { describe, expect, it } from "bun:test";
import { assertNotLastAdmin, isInactive } from "@/lib/access";

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
