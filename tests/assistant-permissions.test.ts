import { describe, expect, it } from "vitest";
import {
  canOrg,
  canProject,
  type OrgRole,
  type ProjectRole,
  requiresStrongSignIn,
} from "@/lib/permissions";

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
});
