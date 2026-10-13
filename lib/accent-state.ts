import type { AccentColor } from "@/lib/accents";

/**
 * `shown` is what the page displays, `confirmed` the last accent the server
 * accepted, `latest` the id of the most recent request.
 */
export type AccentState = {
  shown: AccentColor;
  confirmed: AccentColor;
  latest: number;
};

export function initialAccentState(accent: AccentColor): AccentState {
  return { shown: accent, confirmed: accent, latest: 0 };
}

/** A new request shows at once. `null` when it is already what is shown. */
export function requestAccent(
  state: AccentState,
  accent: AccentColor
): { state: AccentState; id: number } | null {
  if (accent === state.shown) return null;
  const id = state.latest + 1;
  return { state: { ...state, shown: accent, latest: id }, id };
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
  if (ok) {
    return {
      state: { ...state, confirmed: accent },
      repaint: null,
      toast: false,
    };
  }
  if (id !== state.latest) return { state, repaint: null, toast: false };
  return {
    state: { ...state, shown: state.confirmed },
    repaint: state.confirmed,
    toast: true,
  };
}
