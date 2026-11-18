import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { MEMBERSHIP_VISIBLE_ROLES, ORG_WIDE_VISIBLE_ROLES } = await import(
  "@/lib/assignees"
);

// Assignee pickers, environment owners and @mention recipients take a
// membership row only from a role a membership opens projects to: a staff
// user with a leftover row is never offered, nor notified about an issue.
describe("the membership branch of the assignee and mention predicates", () => {
  it("admits every role but staff", () => {
    expect(MEMBERSHIP_VISIBLE_ROLES).toEqual([
      "admin",
      "infra",
      "engineer",
      "qa",
      "ba",
      "pm",
      "observer",
    ]);
  });
  it("never admits staff, through either branch", () => {
    expect(MEMBERSHIP_VISIBLE_ROLES).not.toContain("staff");
    expect(ORG_WIDE_VISIBLE_ROLES).not.toContain("staff");
  });
});
