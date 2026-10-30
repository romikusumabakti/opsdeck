import { hasLocale } from "use-intl/core";
import { defaultLocale, type Locale, locales } from "./locales";

// The visitor's chosen locale, remembered in a cookie so a URL without one
// (`/servers`, a bookmark, a link pasted from elsewhere) lands in it. The name
// and attributes are next-intl's, so the cookie existing users got under Next
// keeps working. The server reads it to pick the redirect target
// (server/static.ts); the client writes it.

export const LOCALE_COOKIE = "NEXT_LOCALE";

// A year, as next-intl's default.
const MAX_AGE = 60 * 60 * 24 * 365;

/** The locale stored in a `Cookie` header value, if it names a valid one. */
export function localeFromCookie(
  cookieHeader: string | null | undefined
): Locale | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const [name, ...value] = pair.split("=");
    if (name?.trim() !== LOCALE_COOKIE) continue;
    const locale = decodeURIComponent(value.join("=").trim());
    if (hasLocale(locales, locale)) return locale;
  }
  return undefined;
}

/** The first locale in a list of language tags (`zh-CN` reads `zh`). */
export function localeFromLanguages(
  languages: readonly string[]
): Locale | undefined {
  for (const tag of languages) {
    const language = tag.split("-")[0]?.toLowerCase();
    if (hasLocale(locales, language)) return language;
  }
  return undefined;
}

/** Remember `locale` for URLs without one (browser only). */
export function persistLocale(locale: Locale): void {
  // biome-ignore lint/suspicious/noDocumentCookie: one plain cookie; the Cookie Store API isn't in every supported browser
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
}

/**
 * The browser-side equivalent of the server's choice for a URL without a
 * locale: the cookie, then the browser's languages, then the default.
 */
export function preferredBrowserLocale(): Locale {
  return (
    localeFromCookie(document.cookie) ??
    localeFromLanguages(navigator.languages ?? []) ??
    defaultLocale
  );
}
