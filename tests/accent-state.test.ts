import { describe, expect, it } from "bun:test";
import {
  type AccentState,
  initialAccentState,
  requestAccent,
  settleAccent,
  skipAccent,
  syncAccent,
} from "@/lib/accent-state";
import type { AccentColor } from "@/lib/accents";

function request(state: AccentState, accent: AccentColor) {
  const r = requestAccent(state, accent);
  if (!r) throw new Error("expected a request");
  return r;
}

describe("accent state", () => {
  it("starts with everything at the initial accent", () => {
    expect(initialAccentState("blue")).toEqual({
      shown: "blue",
      confirmed: "blue",
      latest: 0,
      inFlight: 0,
    });
  });

  it("ignores selecting the shown accent", () => {
    expect(requestAccent(initialAccentState("blue"), "blue")).toBeNull();
  });

  it("shows a request at once and numbers it", () => {
    const r = request(initialAccentState("blue"), "rose");
    expect(r.id).toBe(1);
    expect(r.state).toEqual({
      shown: "rose",
      confirmed: "blue",
      latest: 1,
      inFlight: 1,
    });
  });

  it("confirms a successful save with no repaint or toast", () => {
    const r = request(initialAccentState("blue"), "rose");
    const s = settleAccent(r.state, r.id, "rose", true);
    expect(s.state).toEqual({
      shown: "rose",
      confirmed: "rose",
      latest: 1,
      inFlight: 0,
    });
    expect(s.repaint).toBeNull();
    expect(s.toast).toBe(false);
  });

  it("repaints to the confirmed accent with a toast when a lone save fails", () => {
    const r = request(initialAccentState("blue"), "rose");
    const s = settleAccent(r.state, r.id, "rose", false);
    expect(s.state.shown).toBe("blue");
    expect(s.repaint).toBe("blue");
    expect(s.toast).toBe(true);
  });

  it("ignores a stale failure: blue -> rose -> green, rose fails", () => {
    const a = request(initialAccentState("blue"), "rose");
    const b = request(a.state, "green");
    const s = settleAccent(b.state, a.id, "rose", false);
    expect(s.state).toEqual({ ...b.state, inFlight: 1 });
    expect(s.repaint).toBeNull();
    expect(s.toast).toBe(false);
  });

  it("rolls back to the confirmed accent, not the previous one: green fails after rose saved", () => {
    const a = request(initialAccentState("blue"), "rose");
    const b = request(a.state, "green");
    const afterRose = settleAccent(b.state, a.id, "rose", true);
    const s = settleAccent(afterRose.state, b.id, "green", false);
    expect(s.state.shown).toBe("rose");
    expect(s.state.confirmed).toBe("rose");
    expect(s.repaint).toBe("rose");
    expect(s.toast).toBe(true);
  });

  it("handles out-of-order settling: green succeeds before rose fails", () => {
    const a = request(initialAccentState("blue"), "rose");
    const b = request(a.state, "green");
    const afterGreen = settleAccent(b.state, b.id, "green", true);
    const s = settleAccent(afterGreen.state, a.id, "rose", false);
    expect(s.state).toEqual({
      shown: "green",
      confirmed: "green",
      latest: 2,
      inFlight: 0,
    });
    expect(s.repaint).toBeNull();
    expect(s.toast).toBe(false);
  });

  it("skipping a superseded request leaves nothing in flight and no rollback", () => {
    const a = request(initialAccentState("blue"), "rose");
    const b = request(a.state, "green");
    const skipped = skipAccent(b.state);
    expect(skipped.inFlight).toBe(1);
    const s = settleAccent(skipped, b.id, "green", true);
    expect(s.state).toEqual({
      shown: "green",
      confirmed: "green",
      latest: 2,
      inFlight: 0,
    });
  });

  it("syncs to the server accent when idle", () => {
    const synced = syncAccent(initialAccentState("blue"), "rose");
    expect(synced.shown).toBe("rose");
    expect(synced.confirmed).toBe("rose");
    // and picking the old value is then a real change, not a no-op
    expect(requestAccent(synced, "blue")).not.toBeNull();
  });

  it("returns the same state when already in sync", () => {
    const state = initialAccentState("blue");
    expect(syncAccent(state, "blue")).toBe(state);
  });

  it("ignores the server accent while a request is pending", () => {
    const r = request(initialAccentState("blue"), "rose");
    expect(syncAccent(r.state, "green")).toBe(r.state);
  });

  it("syncs again once the pending request settles", () => {
    const r = request(initialAccentState("blue"), "rose");
    const done = settleAccent(r.state, r.id, "rose", true);
    expect(syncAccent(done.state, "green").shown).toBe("green");
  });
});
