"use client";

import * as React from "react";
import { useRouter } from "@/i18n/navigation";

type StartViewTransition = (cb: () => void) => unknown;

/**
 * Wraps next-intl's router.push in `document.startViewTransition` when the
 * browser supports it. Falls back to a plain push otherwise. Use this for
 * navigations where a crossfade between page states adds clarity (project
 * switching, sidebar item changes) — not for every link, since the API has a
 * non-zero cost.
 */
export function useViewTransitionRouter() {
  const router = useRouter();

  const push = React.useCallback(
    (href: string) => {
      const start = (
        document as Document & { startViewTransition?: StartViewTransition }
      ).startViewTransition?.bind(document);
      if (start) {
        start(() => {
          router.push(href);
        });
        return;
      }
      router.push(href);
    },
    [router]
  );

  return { push };
}
