"use client";

import { createContext, useContext } from "react";

// Whether the current user may run destructive ops (backup/restore/create/drop
// DB, mock time) on the environment in scope. Computed once in the environment
// layout from the effective role and read by every action button below it, so
// users who lack the capability see disabled affordances instead of triggering a
// server-side redirect. This is UX/defense-in-depth only — the server actions
// enforce the same capability regardless of what the UI shows.
const OpsCapabilityContext = createContext(false);

export function OpsCapabilityProvider({
  canRunOps,
  children,
}: {
  canRunOps: boolean;
  children: React.ReactNode;
}) {
  return (
    <OpsCapabilityContext.Provider value={canRunOps}>
      {children}
    </OpsCapabilityContext.Provider>
  );
}

export function useCanRunOps(): boolean {
  return useContext(OpsCapabilityContext);
}
