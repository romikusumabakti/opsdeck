import { describe, expect, it } from "bun:test";
import { disambiguateName, isUniqueViolation } from "@/lib/people/names";

describe("disambiguateName", () => {
  it("keeps the name on attempt 0", () => {
    expect(disambiguateName("Budi Santoso", "budi.s@example.net", 0)).toBe("Budi Santoso");
  });
  it("adds the email local part on attempt 1", () => {
    expect(disambiguateName("Budi Santoso", "budi.s@example.net", 1)).toBe("Budi Santoso (budi.s)");
  });
  it("adds a counter after that", () => {
    expect(disambiguateName("Budi Santoso", "budi.s@example.net", 3)).toBe("Budi Santoso (budi.s) 3");
  });
  it("never exceeds 100 characters", () => {
    expect(disambiguateName("x".repeat(100), "someone@example.net", 2).length).toBeLessThanOrEqual(100);
  });
});

describe("isUniqueViolation", () => {
  it("matches postgres 23505, directly or wrapped in cause", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});
