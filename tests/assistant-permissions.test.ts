import { describe, expect, it, vi } from "vitest";
import {
  canOrg,
  canProject,
  type OrgRole,
  type ProjectRole,
  requiresStrongSignIn,
} from "@/lib/permissions";

vi.mock("@/lib/db", () => ({ db: {} }));

const { resolveProjectAccess } = await import("@/lib/authz");

describe("assistant permissions", () => {
  it.each(["viewer", "qa", "engineer"] as ProjectRole[])(
    "%s may use the assistant on a project",
    (role) => {
      expect(canProject(role, { assistant: ["use"] })).toBe(true);
    }
  );

  it("no role means no access", () => {
    expect(canProject(null, { assistant: ["use"] })).toBe(false);
  });

  it("only admin manages the assistant", () => {
    expect(canOrg("admin", { assistant: ["manage"] })).toBe(true);
    for (const role of [
      "infra",
      "engineer",
      "qa",
      "pm",
      "observer",
    ] as OrgRole[]) {
      expect(canOrg(role, { assistant: ["manage"] })).toBe(false);
    }
  });

  it("managing the assistant needs a strong sign-in", () => {
    expect(requiresStrongSignIn({ assistant: ["manage"] })).toBe(true);
  });

  it("an engineer or qa sees the assistant of their projects only", () => {
    for (const orgRole of ["engineer", "qa"]) {
      const access = resolveProjectAccess(
        orgRole,
        ["p-member", "p-other"],
        ["p-member"]
      );
      expect(
        canProject(access.roles["p-member"] ?? null, { assistant: ["use"] })
      ).toBe(true);
      // No role: the guard answers 404, as if the project did not exist.
      expect(access.roles["p-other"]).toBeUndefined();
    }
  });
});
