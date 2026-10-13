"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { setAccentColor } from "@/actions/profile";
import { useOptimisticPreference } from "@/hooks/use-optimistic-preference";
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
 * Saves are queued and latest-wins (see hooks/use-optimistic-preference.ts).
 */
export function AccentProvider({
  initial,
  children,
}: {
  initial: AccentColor;
  children: React.ReactNode;
}) {
  const t = useTranslations("accentSwitcher");
  const [accent, setAccent] = useOptimisticPreference({
    initial,
    save: setAccentColor,
    apply: paint,
    failedMessage: t("saveFailed"),
  });
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
