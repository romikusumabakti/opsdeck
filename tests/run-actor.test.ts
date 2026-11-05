import { describe, expect, it } from "vitest";
import { firstLine, runActorLabel } from "@/lib/deploy/run-actor";

describe("runActorLabel", () => {
  it("shows the Panel user first", () => {
    expect(
      runActorLabel({ userName: "Romi", triggeredBy: "bot", auto: true })
    ).toEqual({ kind: "user", name: "Romi" });
  });

  it("shows the pusher of an auto run", () => {
    expect(runActorLabel({ userName: null, triggeredBy: "alice" })).toEqual({
      kind: "auto",
      by: "alice",
    });
  });

  it("shows plain auto when the pusher is unknown", () => {
    expect(runActorLabel({ triggeredBy: null, auto: true })).toEqual({
      kind: "auto",
      by: null,
    });
  });

  it("is unknown without user, pusher or auto", () => {
    expect(runActorLabel({ userName: null, triggeredBy: null })).toEqual({
      kind: "unknown",
    });
  });
});

describe("firstLine", () => {
  it("keeps the first line of a commit message", () => {
    expect(firstLine("fix: a\n\nbody")).toBe("fix: a");
    expect(firstLine("  ")).toBeNull();
    expect(firstLine(null)).toBeNull();
  });
});
