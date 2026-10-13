"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { setAccentColor } from "@/actions/profile";
import {
  initialAccentState,
  requestAccent,
  settleAccent,
  skipAccent,
  syncAccent,
} from "@/lib/accent-state";
import { type AccentColor, brandIconSrc } from "@/lib/accents";

type AccentContextValue = {
  accent: AccentColor;
  setAccent: (next: AccentColor) => void;
};

const AccentContext = React.createContext<AccentContextValue | null>(null);

/**
 * Repaint the page and favicon for `accent` without waiting for the server.
 * This writes `data-accent` directly even though the server renders it too;
 * `revalidatePath` in the save action converges the two once a save lands.
 */
function paint(accent: AccentColor) {
  document.documentElement.dataset.accent = accent;
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"]'
  )) {
    link.href = brandIconSrc(accent);
  }
}

/**
 * The signed-in user's accent. `initial` is what the server rendered on
 * <html data-accent>; changes repaint at once and save in the background.
 * Saves run one after another so the database ends on the latest choice, and
 * only the latest request may roll the page back (see lib/accent-state.ts).
 */
export function AccentProvider({
  initial,
  children,
}: {
  initial: AccentColor;
  children: React.ReactNode;
}) {
  const t = useTranslations("accentSwitcher");
  const [accent, setAccentState] = React.useState(initial);
  // The reducer state lives in a ref so callbacks never read a stale render.
  const stateRef = React.useRef(initialAccentState(initial));
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  const tRef = React.useRef(t);
  tRef.current = t;

  const setAccent = React.useCallback((requested: AccentColor) => {
    const req = requestAccent(stateRef.current, requested);
    if (!req) return;
    stateRef.current = req.state;
    paint(requested);
    setAccentState(requested);

    // The chain never rejects, so one failure cannot stall later saves.
    queueRef.current = queueRef.current
      .then(async () => {
        // A newer pick will save instead; skipping avoids replaying this colour.
        if (req.id !== stateRef.current.latest) {
          stateRef.current = skipAccent(stateRef.current);
          return;
        }
        let ok = false;
        try {
          ok = (await setAccentColor(requested)).success;
        } catch {
          ok = false;
        }
        const settled = settleAccent(stateRef.current, req.id, requested, ok);
        stateRef.current = settled.state;
        if (settled.repaint) {
          paint(settled.repaint);
          setAccentState(settled.repaint);
        }
        if (settled.toast) toast.error(tRef.current("saveFailed"));
      })
      .catch(() => {});
  }, []);

  // Follow the server when it renders a different accent (another device, a
  // refresh), unless a save of ours is still pending.
  React.useEffect(() => {
    const next = syncAccent(stateRef.current, initial);
    if (next === stateRef.current) return;
    stateRef.current = next;
    paint(initial);
    setAccentState(initial);
  }, [initial]);

  const value = React.useMemo(
    () => ({ accent, setAccent }),
    [accent, setAccent]
  );
  return (
    <AccentContext.Provider value={value}>{children}</AccentContext.Provider>
  );
}

export function useAccent(): AccentContextValue {
  const ctx = React.useContext(AccentContext);
  if (!ctx) throw new Error("useAccent must be used inside AccentProvider");
  return ctx;
}
