import { describe, expect, it } from "bun:test";
import {
  mapPriority,
  mapStatus,
  mapType,
  normalizeOverrides,
  priorityNameCandidates,
  targetCategoryFor,
} from "@/lib/jira/mapping";

const ENUMS = {
  status: ["open", "in_progress", "resolved", "closed"],
  type: ["bug", "task", "story", "epic"],
  priority: ["low", "medium", "high", "urgent"],
} as const;

describe("mapStatus", () => {
  it("maps by status category, not by name", () => {
    expect(mapStatus({ name: "To Do", categoryKey: "new" })).toBe("open");
    expect(
      mapStatus({ name: "Sedang dikerjakan", categoryKey: "indeterminate" })
    ).toBe("in_progress");
    expect(mapStatus({ name: "已完成", categoryKey: "done" })).toBe("closed");
  });

  it("falls back to open — visible — for an unknown or missing category", () => {
    expect(mapStatus({ name: "Whatever" })).toBe("open");
    expect(mapStatus({ name: "X", categoryKey: "mystery" })).toBe("open");
    expect(mapStatus(null)).toBe("open");
    expect(mapStatus(undefined)).toBe("open");
  });

  it("lets a name override beat the category default", () => {
    const overrides = { status: { "ready for qa": "resolved" as const } };
    expect(
      mapStatus(
        { name: "Ready for QA", categoryKey: "indeterminate" },
        overrides
      )
    ).toBe("resolved");
    // A status the override doesn't mention still uses the category.
    expect(
      mapStatus(
        { name: "In Progress", categoryKey: "indeterminate" },
        overrides
      )
    ).toBe("in_progress");
  });

  it("matches override keys case-insensitively", () => {
    const overrides = { status: { "in review": "resolved" as const } };
    expect(
      mapStatus(
        { name: "  IN REVIEW ", categoryKey: "indeterminate" },
        overrides
      )
    ).toBe("resolved");
  });
});

describe("mapType", () => {
  it("maps the common Jira issue types", () => {
    expect(mapType("Bug")).toBe("bug");
    expect(mapType("Sub-task")).toBe("task");
    expect(mapType("Story")).toBe("story");
    expect(mapType("Epic")).toBe("epic");
    expect(mapType("New Feature")).toBe("story");
  });

  it("treats an unknown or missing type as ordinary work", () => {
    expect(mapType("Spike")).toBe("task");
    expect(mapType(null)).toBe("task");
  });

  it("honors an override", () => {
    expect(mapType("Spike", { type: { spike: "story" } })).toBe("story");
  });
});

describe("mapPriority", () => {
  it("collapses Jira's priority names onto four levels", () => {
    expect(mapPriority("Highest")).toBe("urgent");
    expect(mapPriority("Blocker")).toBe("urgent");
    expect(mapPriority("Major")).toBe("high");
    expect(mapPriority("Normal")).toBe("medium");
    expect(mapPriority("Trivial")).toBe("low");
  });

  it("defaults an unset or unknown priority to medium", () => {
    expect(mapPriority(null)).toBe("medium");
    expect(mapPriority("Spicy")).toBe("medium");
  });

  it("honors an override", () => {
    expect(mapPriority("Spicy", { priority: { spicy: "urgent" } })).toBe(
      "urgent"
    );
  });
});

describe("targetCategoryFor", () => {
  it("pins the ambiguous direction: resolved and closed both mean done", () => {
    expect(targetCategoryFor("open")).toBe("new");
    expect(targetCategoryFor("in_progress")).toBe("indeterminate");
    expect(targetCategoryFor("resolved")).toBe("done");
    expect(targetCategoryFor("closed")).toBe("done");
  });
});

describe("priorityNameCandidates", () => {
  it("offers the aliases a project might use, best first", () => {
    expect(priorityNameCandidates("urgent")[0]).toBe("Highest");
    expect(priorityNameCandidates("urgent")).toContain("Blocker");
    expect(priorityNameCandidates("medium")).toEqual(["Medium", "Normal"]);
  });
});

describe("normalizeOverrides", () => {
  it("lowercases keys and drops values outside the target enums", () => {
    expect(
      normalizeOverrides(
        {
          status: { "Ready For QA": "resolved", Broken: "not_a_status" },
          priority: { Spicy: "urgent" },
        },
        ENUMS
      )
    ).toEqual({
      status: { "ready for qa": "resolved" },
      type: undefined,
      priority: { spicy: "urgent" },
    });
  });

  it("returns null when nothing survives validation", () => {
    expect(normalizeOverrides({ status: { a: "nope" } }, ENUMS)).toBeNull();
    expect(normalizeOverrides({}, ENUMS)).toBeNull();
    expect(normalizeOverrides(null, ENUMS)).toBeNull();
    expect(normalizeOverrides("not an object", ENUMS)).toBeNull();
  });
});
