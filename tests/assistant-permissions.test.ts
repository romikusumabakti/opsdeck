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
      "ba",
      "pm",
      "staff",
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

  // The worker re-checks a pinned question against the viewer's visible
  // projects, and the global gate counts visible projects: both rely on every
  // visible project granting assistant:use.
  it.each(["admin", "infra", "engineer", "qa", "ba", "pm", "observer"])(
    "a %s may use the assistant on every project they see",
    (orgRole) => {
      const access = resolveProjectAccess(
        orgRole,
        ["p-member", "p-other"],
        ["p-member"]
      );
      expect(Object.keys(access.roles).length).toBeGreaterThan(0);
      for (const role of Object.values(access.roles)) {
        expect(canProject(role, { assistant: ["use"] })).toBe(true);
      }
    }
  );

  // The global gate refuses a caller who sees no project: staff, even with a
  // membership row left over from an earlier role.
  it("a staff member sees no project, so the assistant gate refuses them", () => {
    const access = resolveProjectAccess(
      "staff",
      ["p-member", "p-other"],
      ["p-member"]
    );
    expect(access).toEqual({ all: false, roles: {} });
  });
});
