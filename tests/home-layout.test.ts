import { describe, expect, it } from "bun:test";
import {
  defaultIssueTarget,
  firstName,
  greetingKey,
  hourIn,
  sectionOrder,
} from "@/lib/home/layout";

describe("sectionOrder", () => {
  it("ops user with failures: attention first, full", () => {
    expect(
      sectionOrder({ hasOpsAccess: true, attentionCount: 2, issueCount: 5 })
    ).toEqual([
      { id: "attention", mode: "full" },
      { id: "issues", mode: "full" },
    ]);
  });

  it("ops user, all clear: issues first, attention compact", () => {
    expect(
      sectionOrder({ hasOpsAccess: true, attentionCount: 0, issueCount: 5 })
    ).toEqual([
      { id: "issues", mode: "full" },
      { id: "attention", mode: "compact" },
    ]);
  });

  it("non-ops user with no failures: attention hidden", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 0, issueCount: 3 })
    ).toEqual([
      { id: "issues", mode: "full" },
      { id: "attention", mode: "hidden" },
    ]);
  });

  it("non-ops user with issues and visible failures: issues first", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 1, issueCount: 3 })
    ).toEqual([
      { id: "issues", mode: "full" },
      { id: "attention", mode: "full" },
    ]);
  });

  it("no issues but failures: attention first, issues compact", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 1, issueCount: 0 })
    ).toEqual([
      { id: "attention", mode: "full" },
      { id: "issues", mode: "compact" },
    ]);
  });

  it("empty account: issues compact, attention hidden", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 0, issueCount: 0 })
    ).toEqual([
      { id: "issues", mode: "compact" },
      { id: "attention", mode: "hidden" },
    ]);
  });
});

describe("greetingKey", () => {
  it.each([
    [3, "night"],
    [4, "morning"],
    [10, "morning"],
    [11, "midday"],
    [14, "midday"],
    [15, "afternoon"],
    [17, "afternoon"],
    [18, "night"],
    [23, "night"],
    [0, "night"],
  ] as const)("hour %i → %s", (hour, key) => {
    expect(greetingKey(hour)).toBe(key);
  });
});

describe("hourIn", () => {
  it("converts to the target zone across the UTC date line", () => {
    expect(hourIn("Asia/Jakarta", new Date("2026-10-02T23:30:00Z"))).toBe(6);
  });
  it("returns 0, not 24, at midnight", () => {
    expect(hourIn("UTC", new Date("2026-10-03T00:15:00Z"))).toBe(0);
  });
});

describe("firstName", () => {
  it("takes the first word", () => {
    expect(firstName("Romi Kusuma Bakti")).toBe("Romi");
  });
  it("trims and handles single names", () => {
    expect(firstName("  Indri ")).toBe("Indri");
  });
  it("keeps an empty name empty", () => {
    expect(firstName("")).toBe("");
  });
});

describe("defaultIssueTarget", () => {
  const recent = [
    { id: "env1", projectId: "pA" },
    { id: "env2", projectId: "pB" },
  ];
  it("picks the most recent environment in a writable project", () => {
    expect(defaultIssueTarget(recent, new Set(["pB"]))).toEqual({
      projectId: "pB",
      environmentId: "env2",
    });
  });
  it("is null when the user can write nowhere", () => {
    expect(defaultIssueTarget(recent, new Set())).toBeNull();
  });
});
