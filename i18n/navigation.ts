import { useQueryClient } from "@tanstack/react-query";
import {
  Link as RouterLink,
  notFound as routerNotFound,
  redirect as routerRedirect,
  useLocation,
  useParams as useRouterParams,
  useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { hasLocale } from "use-intl";
import { parseSearch } from "@/web/search-params";
import { defaultLocale, type Locale, locales } from "./locales";

// Locale-aware navigation on TanStack Router, with the API next-intl's
// `createNavigation` and `next/navigation` gave the components: hrefs are
// written without the locale (`/servers/abc`) and every helper adds the
// current one. An href that already carries a locale (`/id/servers`, e.g. an
// anchor's resolved href replayed by the navigation guard) or is absolute
// (`https://…`) is left alone, so a value can safely pass through twice.

const LOCALE_PREFIX = new RegExp(`^/(${locales.join("|")})(?=/|[?#]|$)`);
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/** The locale a path starts with, or the default. */
export function localeFromPath(pathname: string): Locale {
  const first = pathname.split("/")[1];
  return hasLocale(locales, first) ? first : defaultLocale;
}

/** `pathname` without its locale prefix; `/` for the locale root. */
export function stripLocale(pathname: string): string {
  return pathname.replace(LOCALE_PREFIX, "") || "/";
}

/** `href` under `/<locale>`, unless it already has a locale or a scheme. */
export function localizeHref(href: string, locale: Locale): string {
  if (HAS_SCHEME.test(href) || href.startsWith("//")) return href;
  if (LOCALE_PREFIX.test(href)) return href;
  if (href === "" || href === "/") return `/${locale}`;
  if (href.startsWith("?") || href.startsWith("#")) return `/${locale}${href}`;
  return `/${locale}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * An in-app href as TanStack navigation options. The query goes through the
 * router's own codec (web/search-params.ts), so it comes out as written.
 */
function navigationTarget(href: string) {
  const url = new URL(href, "http://localhost");
  const search = parseSearch(url.search);
  return {
    to: url.pathname,
    search: () => search,
    hash: url.hash.slice(1) || undefined,
  };
}

function useCurrentLocale(): Locale {
  const locale = useRouterParams({
    strict: false,
    select: (params: { locale?: unknown }) => params.locale,
  });
  return hasLocale(locales, locale) ? locale : defaultLocale;
}

type LinkProps = Omit<React.ComponentPropsWithRef<"a">, "href"> & {
  href: string;
  /** Link into another locale (the locale switcher). */
  locale?: Locale;
  /** Accepted for next/link compatibility; TanStack preloads on intent. */
  prefetch?: boolean | null;
  /** Replace the history entry instead of pushing one. */
  replace?: boolean;
  /** `false` keeps the scroll position (next/link's `scroll={false}`). */
  scroll?: boolean;
};

/**
 * An in-app link. Renders TanStack's `<Link>` (client-side navigation, intent
 * preloading) to `/<locale><href>`; any other anchor prop passes through,
 * including the `ref` and handlers base-ui's `render={<Link … />}` merges in.
 */
export function Link({
  href,
  locale,
  prefetch: _prefetch,
  replace,
  scroll,
  ...anchor
}: LinkProps) {
  const current = useCurrentLocale();
  const target = localizeHref(href, locale ?? current);
  if (HAS_SCHEME.test(target) || target.startsWith("//")) {
    return React.createElement("a", { ...anchor, href: target });
  }
  const { to, search, hash } = navigationTarget(target);
  return React.createElement(RouterLink, {
    ...anchor,
    to,
    // The route behind a runtime string is unknown to the type system, which
    // then types a search reducer as returning `never`; the value is the
    // href's own query, so there is nothing for it to check.
    search: search as never,
    hash,
    replace,
    resetScroll: scroll,
  });
}

type NavigateOptions = {
  /** Navigate into another locale (the locale switcher). */
  locale?: Locale;
  /** `false` keeps the scroll position. */
  scroll?: boolean;
};

export type AppRouter = {
  push: (href: string, options?: NavigateOptions) => void;
  replace: (href: string, options?: NavigateOptions) => void;
  back: () => void;
  /**
   * Refetch everything on the page — what `router.refresh()` re-rendering the
   * server components did. Unlike the refetch after a mutation, this includes
   * the remote probes (backup and database lists): it is an explicit ask.
   */
  refresh: () => void;
  prefetch: (href: string) => void;
};

/** `useRouter()` from next-intl / next/navigation, on TanStack Router. */
export function useRouter(): AppRouter {
  const router = useTanStackRouter();
  const queryClient = useQueryClient();
  const current = useCurrentLocale();
  return React.useMemo(() => {
    const go = (href: string, replace: boolean, options?: NavigateOptions) => {
      void router.navigate({
        ...navigationTarget(localizeHref(href, options?.locale ?? current)),
        replace,
        resetScroll: options?.scroll,
      });
    };
    return {
      push: (href, options) => go(href, false, options),
      replace: (href, options) => go(href, true, options),
      back: () => router.history.back(),
      refresh: () => {
        void queryClient.invalidateQueries();
        void router.invalidate();
      },
      prefetch: (href) => {
        void router
          .preloadRoute(navigationTarget(localizeHref(href, current)))
          .catch(() => {});
      },
    };
  }, [router, queryClient, current]);
}

/** The current path without its locale (`/servers/abc`), like next-intl's. */
export function usePathname(): string {
  return stripLocale(useLocation({ select: (l) => l.pathname }));
}

/** The current query string, as next/navigation's `useSearchParams()`. */
export function useSearchParams(): URLSearchParams {
  const searchStr = useLocation({ select: (l) => l.searchStr });
  return React.useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

/** Every path param of the current match (`{ locale, projectKey, … }`). */
export function useParams() {
  return useRouterParams({ strict: false });
}

/** next-intl's `getPathname`: the localized path for an href. */
export function getPathname({
  href,
  locale,
}: {
  href: string;
  locale: Locale;
}): string {
  return localizeHref(href, locale);
}

/**
 * Redirect from a route's `beforeLoad` or `loader`, keeping the locale. Throws,
 * like next-intl's server `redirect`.
 *
 * Pass the route's `params.locale`: during an intent preload the loader runs
 * for a URL the address bar doesn't show yet, which may be in another locale.
 * Without it the address bar's locale is used — right for a navigation that
 * has already committed, which is when a beforeLoad/loader redirect matters.
 */
export function redirect(href: string, locale?: Locale): never {
  throw routerRedirect({
    href: localizeHref(
      href,
      locale ?? localeFromPath(window.location.pathname)
    ),
  });
}

/**
 * Render the nearest not-found boundary. Throws, like next/navigation's
 * `notFound()`, so a bare `notFound();` statement keeps working in loaders.
 */
export function notFound(): never {
  throw routerNotFound();
}
