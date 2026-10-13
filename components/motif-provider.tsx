"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { setMotif } from "@/actions/profile";
import { useOptimisticPreference } from "@/hooks/use-optimistic-preference";
import {
  type MotifPreference,
  type MotifSlug,
  resolveMotif,
} from "@/lib/motifs";

type MotifContextValue = {
  preference: MotifPreference;
  /** What to draw now; null when the user chose none. */
  motif: MotifSlug | null;
  /** Today's rotating motif, computed by the server in APP_TIMEZONE. */
  today: MotifSlug;
  setPreference: (next: MotifPreference) => void;
};

const MotifContext = React.createContext<MotifContextValue | null>(null);

/** The signed-in user's background motif; changes apply at once and save in the background. */
export function MotifProvider({
  initial,
  today,
  children,
}: {
  initial: MotifPreference;
  today: MotifSlug;
  children: React.ReactNode;
}) {
  const t = useTranslations("motifs");
  const [preference, setPreference] = useOptimisticPreference({
    initial,
    save: setMotif,
    failedMessage: t("saveFailed"),
  });
  const value = React.useMemo(
    () => ({
      preference,
      motif: resolveMotif(preference, today),
      today,
      setPreference,
    }),
    [preference, today, setPreference]
  );
  return (
    <MotifContext.Provider value={value}>{children}</MotifContext.Provider>
  );
}

export function useMotif(): MotifContextValue {
  const ctx = React.useContext(MotifContext);
  if (!ctx) throw new Error("useMotif must be used inside MotifProvider");
  return ctx;
}
