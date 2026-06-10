"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useDialog } from "@/components/dialog-provider";

type GuardContextValue = {
  register: (predicate: () => boolean) => () => void;
};

const NavigationGuardContext = React.createContext<GuardContextValue | null>(
  null
);

/**
 * App-wide guard against losing unsaved form changes via in-app navigation.
 *
 * Forms register a predicate (via {@link useNavigationGuard}) that returns
 * `true` while they hold unsaved changes. A capture-phase click listener
 * intercepts internal anchor navigations (next-intl `<Link>` renders an
 * `<a>`, so sidebar/breadcrumb/command items are covered) and asks for
 * confirmation before leaving. Tab close / reload stay covered separately by
 * {@link useUnsavedChanges}'s `beforeunload` handler.
 *
 * Not covered: programmatic `router.push` that bypasses an anchor (rare while
 * a form is dirty). Those callers can await `useDialog().confirm` themselves.
 */
export function NavigationGuardProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { confirm } = useDialog();
  const t = useTranslations("unsavedChanges");
  const guards = React.useRef(new Set<() => boolean>());

  const register = React.useCallback((predicate: () => boolean) => {
    guards.current.add(predicate);
    return () => {
      guards.current.delete(predicate);
    };
  }, []);

  const shouldBlock = React.useCallback(() => {
    for (const predicate of guards.current) {
      if (predicate()) return true;
    }
    return false;
  }, []);

  React.useEffect(() => {
    async function onClick(e: MouseEvent) {
      // Let the browser/other handlers own modified clicks (new tab, etc.).
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const anchor = (e.target as HTMLElement | null)?.closest("a");
      const href = anchor?.getAttribute("href");
      if (
        !anchor ||
        !href ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:")
      ) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same URL (or hash-only change) is not a navigation worth guarding.
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }
      if (!shouldBlock()) return;

      e.preventDefault();
      e.stopPropagation();
      const target = url.pathname + url.search + url.hash;
      const ok = await confirm({
        title: t("title"),
        description: t("description"),
        confirmText: t("leave"),
        cancelText: t("stay"),
        destructive: true,
      });
      if (ok) router.push(target);
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [shouldBlock, confirm, router, t]);

  return (
    <NavigationGuardContext.Provider
      value={React.useMemo(() => ({ register }), [register])}
    >
      {children}
    </NavigationGuardContext.Provider>
  );
}

/**
 * Register an unsaved-changes guard for the lifetime of the component. While
 * `when` is true, in-app navigation prompts for confirmation. No-op outside a
 * {@link NavigationGuardProvider}.
 */
export function useNavigationGuard(when: boolean): void {
  const ctx = React.useContext(NavigationGuardContext);
  // Read the latest `when` through a ref so the registered predicate never
  // goes stale without re-registering on every keystroke.
  const whenRef = React.useRef(when);
  whenRef.current = when;

  React.useEffect(() => {
    if (!ctx) return;
    return ctx.register(() => whenRef.current);
  }, [ctx]);
}
