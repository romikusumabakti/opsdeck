"use client";

import { useEffect, useState } from "react";

/**
 * Detects whether the current platform is macOS so the UI can show the right
 * command modifier (⌘ on Mac, Ctrl elsewhere). Returns `false` during SSR and
 * the first client render to stay hydration-safe, then resolves after mount.
 */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const platform =
      // userAgentData is the modern source; fall back to platform/userAgent.
      (
        navigator as Navigator & {
          userAgentData?: { platform?: string };
        }
      ).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent;
    setIsMac(/mac/i.test(platform));
  }, []);

  return isMac;
}

/** The command modifier symbol for the current platform: `⌘` on Mac, `Ctrl`. */
export function useModKey(): string {
  return useIsMac() ? "⌘" : "Ctrl";
}
