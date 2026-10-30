import { createMiddleware } from "hono/factory";
import { parseAccept } from "hono/utils/accept";
import { hasLocale } from "use-intl/core";
import { localeFromCookie } from "@/i18n/locale-preference";
import { defaultLocale, type Locale, locales } from "@/i18n/locales";
import type { AppEnv } from "@/server/context";

// The locale lives in the SPA's URL (`/<locale>/...`), which the API never
// sees, so the client states it explicitly in `X-Locale`. Accept-Language is
// the fallback for requests that don't come through the API client — a fresh
// tab hitting an auth callback, curl — and the default locale catches the rest.
// An unsupported X-Locale falls through rather than winning, so a stale client
// can't pin a request to a locale whose messages no longer exist.

function fromAcceptLanguage(header: string | null): Locale | undefined {
  if (!header) return undefined;
  // parseAccept sorts by q. Only the primary subtag matters: messages exist
  // per language, not per region, so `zh-CN` and `zh-TW` both read `zh`.
  for (const { type, q } of parseAccept(header)) {
    if (q <= 0) continue;
    const language = type.split("-")[0]?.toLowerCase();
    if (hasLocale(locales, language)) return language;
  }
  return undefined;
}

export function resolveLocale(headers: Headers): Locale {
  const explicit = headers.get("x-locale")?.toLowerCase();
  if (hasLocale(locales, explicit)) return explicit;
  return fromAcceptLanguage(headers.get("accept-language")) ?? defaultLocale;
}

/**
 * The locale for a page URL that has none (server/static.ts redirects it): the
 * visitor's last choice in the NEXT_LOCALE cookie, then Accept-Language, then
 * the default — next-intl's order.
 */
export function preferredLocale(headers: Headers): Locale {
  return (
    localeFromCookie(headers.get("cookie")) ??
    fromAcceptLanguage(headers.get("accept-language")) ??
    defaultLocale
  );
}

export const locale = createMiddleware<AppEnv>(async (c, next) => {
  c.set("locale", resolveLocale(c.req.raw.headers));
  await next();
});
