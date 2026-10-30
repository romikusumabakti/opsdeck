import { describe, expect, it } from "vitest";
import type { AccentColor } from "@/lib/accents";
import type { MotifPreference } from "@/lib/motifs";
import {
  initialPreferenceState,
  type PreferenceState,
  requestPreference,
  settlePreference,
  skipPreference,
  syncPreference,
} from "@/lib/optimistic-preference";

function request(state: PreferenceState<AccentColor>, accent: AccentColor) {
  const r = requestPreference(state, accent);
  if (!r) throw new Error("expected a request");
  return r;
}

describe("optimistic preference", () => {
  it("starts with everything at the initial accent", () => {
    expect(initialPreferenceState("blue")).toEqual({
      shown: "blue",
      confirmed: "blue",
      latest: 0,
      inFlight: 0,
    });
  });

  it("ignores selecting the shown accent", () => {
    expect(
      requestPreference(initialPreferenceState("blue"), "blue")
    ).toBeNull();
  });

  it("shows a request at once and numbers it", () => {
    const r = request(initialPreferenceState("blue"), "rose");
    expect(r.id).toBe(1);
    expect(r.state).toEqual({
      shown: "rose",
      confirmed: "blue",
      latest: 1,
      inFlight: 1,
    });
  });

  it("confirms a successful save with no repaint or toast", () => {
    const r = request(initialPreferenceState("blue"), "rose");
    const s = settlePreference(r.state, r.id, "rose", true);
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
    const r = request(initialPreferenceState("blue"), "rose");
    const s = settlePreference(r.state, r.id, "rose", false);
    expect(s.state.shown).toBe("blue");
    expect(s.repaint).toBe("blue");
    expect(s.toast).toBe(true);
  });

  it("ignores a stale failure: blue -> rose -> green, rose fails", () => {
    const a = request(initialPreferenceState("blue"), "rose");
    const b = request(a.state, "green");
    const s = settlePreference(b.state, a.id, "rose", false);
    expect(s.state).toEqual({ ...b.state, inFlight: 1 });
    expect(s.repaint).toBeNull();
    expect(s.toast).toBe(false);
  });

  it("rolls back to the confirmed accent, not the previous one: green fails after rose saved", () => {
    const a = request(initialPreferenceState("blue"), "rose");
    const b = request(a.state, "green");
    const afterRose = settlePreference(b.state, a.id, "rose", true);
    const s = settlePreference(afterRose.state, b.id, "green", false);
    expect(s.state.shown).toBe("rose");
    expect(s.state.confirmed).toBe("rose");
    expect(s.repaint).toBe("rose");
    expect(s.toast).toBe(true);
  });

  it("handles out-of-order settling: green succeeds before rose fails", () => {
    const a = request(initialPreferenceState("blue"), "rose");
    const b = request(a.state, "green");
    const afterGreen = settlePreference(b.state, b.id, "green", true);
    const s = settlePreference(afterGreen.state, a.id, "rose", false);
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
    const a = request(initialPreferenceState("blue"), "rose");
    const b = request(a.state, "green");
    const skipped = skipPreference(b.state);
    expect(skipped.inFlight).toBe(1);
    const s = settlePreference(skipped, b.id, "green", true);
    expect(s.state).toEqual({
      shown: "green",
      confirmed: "green",
      latest: 2,
      inFlight: 0,
    });
  });

  it("syncs to the server accent when idle", () => {
    const synced = syncPreference(initialPreferenceState("blue"), "rose");
    expect(synced.shown).toBe("rose");
    expect(synced.confirmed).toBe("rose");
    // and picking the old value is then a real change, not a no-op
    expect(requestPreference(synced, "blue")).not.toBeNull();
  });

  it("returns the same state when already in sync", () => {
    const state = initialPreferenceState("blue");
    expect(syncPreference(state, "blue")).toBe(state);
  });

  it("ignores the server accent while a request is pending", () => {
    const r = request(initialPreferenceState("blue"), "rose");
    expect(syncPreference(r.state, "green")).toBe(r.state);
  });

  it("syncs again once the pending request settles", () => {
    const r = request(initialPreferenceState("blue"), "rose");
    const done = settlePreference(r.state, r.id, "rose", true);
    expect(syncPreference(done.state, "green").shown).toBe("green");
  });
});

describe("optimistic preference with motifs", () => {
  it("rolls a failed latest save back to the confirmed motif", () => {
    let state = initialPreferenceState<MotifPreference>("daily");
    const a = requestPreference(state, "kawung");
    if (!a) throw new Error("expected a request");
    const b = requestPreference(a.state, "none");
    if (!b) throw new Error("expected a request");
    state = settlePreference(b.state, a.id, "kawung", true).state;
    const s = settlePreference(state, b.id, "none", false);
    expect(s.repaint).toBe("kawung");
    expect(s.toast).toBe(true);
    expect(s.state).toMatchObject({
      shown: "kawung",
      confirmed: "kawung",
      inFlight: 0,
    });
  });
});
