import { redirect } from "@tanstack/react-router";
import { hasLocale } from "use-intl";
import { defaultLocale, locales } from "@/i18n/locales";

// Pages a signed-out visitor may open: signing in, and getting an account in
// the first place. Everything else needs a session.
const PUBLIC_FIRST_SEGMENTS = new Set([
  "sign-in",
  "accept-invite",
  "setup",
  "forgot-password",
  "reset-password",
]);

/** Whether `path` (without its locale) is one of those pages. */
export function isPublicPath(path: string): boolean {
  const first = path.split(/[/?#]/)[1] ?? "";
  return PUBLIC_FIRST_SEGMENTS.has(first);
}

/**
 * The `$locale` route's sign-in check. Pure: it takes the location and the
 * `/api/me` answer and returns the redirect to throw, or null to let the page
 * load.
 *
 * It keys on `/api/me`, not on the cookie the old proxy looked for, so an
 * expired or revoked session lands on sign-in too instead of on a page whose
 * every request fails. The target is remembered without its locale (the
 * sign-in page re-adds the one the user is reading in) and with its query.
 */
export function authGate(
  location: { pathname: string; searchStr?: string },
  me: unknown
) {
  if (me) return null;
  const [, first = "", ...rest] = location.pathname.split("/");
  const locale = hasLocale(locales, first) ? first : defaultLocale;
  const stripped = hasLocale(locales, first) ? rest : [first, ...rest];
  if (PUBLIC_FIRST_SEGMENTS.has(stripped[0] ?? "")) return null;
  const path = `/${stripped.join("/")}`.replace(/\/+$/, "") || "/";
  return redirect({
    to: "/$locale/sign-in",
    params: { locale },
    search: { redirect: path + (location.searchStr ?? "") },
  });
}
