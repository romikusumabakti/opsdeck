"use client";

import { useEffect } from "react";

/**
 * Warn the user before they close the tab or reload while unsaved changes
 * are present. Browsers ignore custom messages — they show a generic prompt —
 * but `preventDefault()` + `returnValue` is the documented activator.
 *
 * Intra-app navigation (clicking a Next.js Link) is NOT intercepted: the
 * App Router does not yet expose a stable navigation-guard API. This hook
 * covers tab close, reload, and external links, which is the majority of
 * data-loss risk.
 */
export function useUnsavedChanges(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [enabled]);
}
