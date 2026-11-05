import { describe, expect, it } from "vitest";
import { autoRunActor, firstLine, runActorLabel } from "@/lib/deploy/run-actor";

describe("runActorLabel", () => {
  it("shows the Panel user first", () => {
    expect(
      runActorLabel({
        userName: "Romi",
        autoUserName: "Alice",
        triggeredBy: "bot",
        auto: true,
      })
    ).toEqual({ kind: "user", name: "Romi" });
  });

  it("shows the Panel user an auto run's actor resolves to", () => {
    expect(
      runActorLabel({
        userName: null,
        autoUserName: "Alice",
        triggeredBy: "alice@dssconsulting.id",
      })
    ).toEqual({ kind: "autoUser", name: "Alice" });
  });

  it("shows the pusher of an auto run", () => {
    expect(runActorLabel({ userName: null, triggeredBy: "alice" })).toEqual({
      kind: "auto",
      by: "alice",
    });
  });

  it("shows the commit email of an auto run with no matching Panel user", () => {
    expect(
      runActorLabel({ autoUserName: null, triggeredBy: "bob@x.test" })
    ).toEqual({ kind: "auto", by: "bob@x.test" });
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

describe("autoRunActor", () => {
  it("prefers the pusher login", () => {
    expect(
      autoRunActor({ pushedBy: "alice", commitAuthorEmail: "a@x.test" })
    ).toBe("alice");
  });

  it("falls back to the commit author email, trimmed and lower-cased", () => {
    expect(
      autoRunActor({ pushedBy: null, commitAuthorEmail: "  Romi.K@DSS.test " })
    ).toBe("romi.k@dss.test");
    expect(
      autoRunActor({ pushedBy: "  ", commitAuthorEmail: "a@x.test" })
    ).toBe("a@x.test");
  });

  it("is null when neither is known", () => {
    expect(autoRunActor({ pushedBy: null, commitAuthorEmail: " " })).toBeNull();
    expect(
      autoRunActor({ pushedBy: null, commitAuthorEmail: null })
    ).toBeNull();
  });
});

describe("firstLine", () => {
  it("keeps the first line of a commit message", () => {
    expect(firstLine("fix: a\n\nbody")).toBe("fix: a");
    expect(firstLine("  ")).toBeNull();
    expect(firstLine(null)).toBeNull();
  });
});
