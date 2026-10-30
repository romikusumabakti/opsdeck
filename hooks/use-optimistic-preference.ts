import * as React from "react";
import { toast } from "sonner";
import {
  initialPreferenceState,
  requestPreference,
  settlePreference,
  skipPreference,
  syncPreference,
} from "@/lib/optimistic-preference";

/**
 * A preference the UI applies at once and saves in the background. Saves run
 * one after another so the database ends on the latest choice; only the
 * latest request may roll the UI back (lib/optimistic-preference.ts).
 * `initial` is the server-rendered value; when it changes (another device, a
 * refresh) the hook follows it unless a save of ours is pending. `apply` runs
 * for every change the page must reflect outside React (e.g. <html> attrs).
 */
export function useOptimisticPreference<T extends string>({
  initial,
  save,
  apply,
  failedMessage,
}: {
  initial: T;
  save: (value: T) => Promise<{ success: boolean }>;
  apply?: (value: T) => void;
  failedMessage: string;
}): [T, (next: T) => void] {
  const [shown, setShown] = React.useState(initial);
  // Reducer state in a ref so callbacks never read a stale render.
  const stateRef = React.useRef(initialPreferenceState(initial));
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  const optsRef = React.useRef({ save, apply, failedMessage });
  optsRef.current = { save, apply, failedMessage };

  const show = React.useCallback((value: T) => {
    optsRef.current.apply?.(value);
    setShown(value);
  }, []);

  const set = React.useCallback(
    (requested: T) => {
      const req = requestPreference(stateRef.current, requested);
      if (!req) return;
      stateRef.current = req.state;
      show(requested);

      // The chain never rejects, so one failure cannot stall later saves.
      queueRef.current = queueRef.current
        .then(async () => {
          // A newer pick will save instead; skipping avoids replaying this one.
          if (req.id !== stateRef.current.latest) {
            stateRef.current = skipPreference(stateRef.current);
            return;
          }
          let ok = false;
          try {
            ok = (await optsRef.current.save(requested)).success;
          } catch {
            ok = false;
          }
          const settled = settlePreference(
            stateRef.current,
            req.id,
            requested,
            ok
          );
          stateRef.current = settled.state;
          if (settled.repaint) show(settled.repaint);
          if (settled.toast) toast.error(optsRef.current.failedMessage);
        })
        .catch(() => {});
    },
    [show]
  );

  React.useEffect(() => {
    const next = syncPreference(stateRef.current, initial);
    if (next === stateRef.current) return;
    stateRef.current = next;
    show(initial);
  }, [initial, show]);

  return [shown, set];
}
