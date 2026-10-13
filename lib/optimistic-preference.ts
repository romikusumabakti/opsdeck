/**
 * Latest-wins state for a user preference that the UI applies at once and
 * saves in the background (accent colour, background motif). `shown` is what
 * the page displays, `confirmed` the last value the server accepted, `latest`
 * the id of the most recent request, and `inFlight` how many requests have
 * been made but not yet settled or skipped.
 */
export type PreferenceState<T extends string> = {
  shown: T;
  confirmed: T;
  latest: number;
  inFlight: number;
};

export function initialPreferenceState<T extends string>(
  value: T
): PreferenceState<T> {
  return { shown: value, confirmed: value, latest: 0, inFlight: 0 };
}

/** A new request shows at once. `null` when it is already what is shown. */
export function requestPreference<T extends string>(
  state: PreferenceState<T>,
  value: T
): { state: PreferenceState<T>; id: number } | null {
  if (value === state.shown) return null;
  const id = state.latest + 1;
  return {
    state: { ...state, shown: value, latest: id, inFlight: state.inFlight + 1 },
    id,
  };
}

/**
 * Record the outcome of request `id` (which asked for `value`). Latest wins:
 * a failure only rolls the UI back when no newer request exists, and it rolls
 * back to the last confirmed value, not to whatever was shown before.
 */
export function settlePreference<T extends string>(
  state: PreferenceState<T>,
  id: number,
  value: T,
  ok: boolean
): { state: PreferenceState<T>; repaint: T | null; toast: boolean } {
  const inFlight = Math.max(0, state.inFlight - 1);
  if (ok) {
    return {
      state: { ...state, confirmed: value, inFlight },
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
export function skipPreference<T extends string>(
  state: PreferenceState<T>
): PreferenceState<T> {
  return { ...state, inFlight: Math.max(0, state.inFlight - 1) };
}

/**
 * Follow the server-rendered value (e.g. changed on another device). Ignored
 * while a request is in flight: that flow converges on its own.
 */
export function syncPreference<T extends string>(
  state: PreferenceState<T>,
  server: T
): PreferenceState<T> {
  if (state.inFlight > 0) return state;
  if (state.shown === server && state.confirmed === server) return state;
  return { ...state, shown: server, confirmed: server };
}
