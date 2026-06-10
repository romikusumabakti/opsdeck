"use client";

import { useEffect } from "react";
import { useNavigationGuard } from "@/components/navigation-guard";

/**
 * Warn the user before discarding unsaved changes. Covers two exit paths:
 *
 * - Tab close / reload / external links — via `beforeunload`. Browsers ignore
 *   custom messages and show a generic prompt, but `preventDefault()` +
 *   `returnValue` is the documented activator.
 * - In-app navigation (clicking a Next.js `<Link>`) — via the app-wide
 *   {@link useNavigationGuard}, which intercepts internal anchor clicks and
 *   asks for confirmation before leaving.
 */
export function useUnsavedChanges(enabled: boolean): void {
  useNavigationGuard(enabled);

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
