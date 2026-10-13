import type { AccentColor } from "@/lib/accents";

/**
 * `shown` is what the page displays, `confirmed` the last accent the server
 * accepted, `latest` the id of the most recent request, and `inFlight` how
 * many requests have been made but not yet settled or skipped.
 */
export type AccentState = {
  shown: AccentColor;
  confirmed: AccentColor;
  latest: number;
  inFlight: number;
};

export function initialAccentState(accent: AccentColor): AccentState {
  return { shown: accent, confirmed: accent, latest: 0, inFlight: 0 };
}

/** A new request shows at once. `null` when it is already what is shown. */
export function requestAccent(
  state: AccentState,
  accent: AccentColor
): { state: AccentState; id: number } | null {
  if (accent === state.shown) return null;
  const id = state.latest + 1;
  return {
    state: {
      ...state,
      shown: accent,
      latest: id,
      inFlight: state.inFlight + 1,
    },
    id,
  };
}

/**
 * Record the outcome of request `id` (which asked for `accent`). Latest wins:
 * a failure only rolls the UI back when no newer request exists, and it rolls
 * back to the last confirmed accent, not to whatever was shown before.
 */
export function settleAccent(
  state: AccentState,
  id: number,
  accent: AccentColor,
  ok: boolean
): { state: AccentState; repaint: AccentColor | null; toast: boolean } {
  const inFlight = Math.max(0, state.inFlight - 1);
  if (ok) {
    return {
      state: { ...state, confirmed: accent, inFlight },
      repaint: null,
      toast: false,
    };
  }
  if (id !== state.latest) {
    return { state: { ...state, inFlight }, repaint: null, toast: false };
  }
  return {
    state: { ...state, shown: state.confirmed, inFlight },
    repaint: state.confirmed,
    toast: true,
  };
}

/**
 * Drop a request without saving it because a newer one supersedes it. It is
 * no longer in flight and never settles, so it cannot roll anything back.
 */
export function skipAccent(state: AccentState): AccentState {
  return { ...state, inFlight: Math.max(0, state.inFlight - 1) };
}

/**
 * Follow the server-rendered accent (e.g. changed on another device). Ignored
 * while a request is in flight: that flow converges on its own.
 */
export function syncAccent(
  state: AccentState,
  serverAccent: AccentColor
): AccentState {
  if (state.inFlight > 0) return state;
  if (state.shown === serverAccent && state.confirmed === serverAccent) {
    return state;
  }
  return { ...state, shown: serverAccent, confirmed: serverAccent };
}
