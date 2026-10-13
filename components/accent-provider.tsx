"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { setAccentColor } from "@/actions/profile";
import { nextAccentState } from "@/lib/accent-state";
import { type AccentColor, brandIconSrc } from "@/lib/accents";

type AccentContextValue = {
  accent: AccentColor;
  setAccent: (next: AccentColor) => void;
};

const AccentContext = React.createContext<AccentContextValue | null>(null);

/** Repaint the page and favicon for `accent` without waiting for the server. */
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
 * <html data-accent>; changes repaint at once and save in the background,
 * rolling back with a toast if the save fails.
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
  const [, startTransition] = React.useTransition();

  const setAccent = React.useCallback(
    (requested: AccentColor) => {
      const optimistic = nextAccentState(accent, requested, "pending");
      if (!optimistic) return;
      paint(optimistic.apply);
      setAccentState(optimistic.apply);
      startTransition(async () => {
        let outcome: "saved" | "failed" = "failed";
        try {
          outcome = (await setAccentColor(requested)).success
            ? "saved"
            : "failed";
        } catch {
          outcome = "failed";
        }
        const settled = nextAccentState(accent, requested, outcome);
        if (settled && outcome === "failed") {
          paint(settled.apply);
          setAccentState(settled.apply);
          toast.error(t("saveFailed"));
        }
      });
    },
    [accent, t]
  );

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
