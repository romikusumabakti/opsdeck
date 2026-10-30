import * as React from "react";
import { useTranslations } from "use-intl";
import { useOptimisticPreference } from "@/hooks/use-optimistic-preference";
import type { AccentColor } from "@/lib/accents";
import { setAccentColor } from "@/web/api/profile";
import { applyDocumentAccent } from "@/web/document-locale";

type AccentContextValue = {
  accent: AccentColor;
  setAccent: (next: AccentColor) => void;
};

const AccentContext = React.createContext<AccentContextValue | null>(null);

/**
 * The signed-in user's accent. `initial` is the stored choice (or the brand
 * default); changes repaint at once and save in the background. Saves are queued and latest-wins (see
 * hooks/use-optimistic-preference.ts).
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
    failedMessage: t("saveFailed"),
  });
  // Paints the shown accent: on mount, on a pick, and on a rollback.
  React.useEffect(() => {
    applyDocumentAccent(accent);
  }, [accent]);
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
