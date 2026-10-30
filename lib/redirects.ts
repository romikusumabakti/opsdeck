import { defaultLocale, type Locale, locales } from "@/i18n/locales";
import { canonicalProjectPath } from "@/lib/canonical-path";

// Every URL the app answers somewhere else, in one place, so the server (a real
// HTTP redirect, server/static.ts) and the SPA (a client-side fallback in the
// root route) agree. Under Next these were three mechanisms: next-intl's
// middleware added the missing locale, next.config.ts moved /users, /jira and
// /activity under /admin, and proxy.ts fixed the project-key casing.
//
// Dependency-free apart from the pure path helpers, so it runs in the browser.

const LOCALE_PREFIX = new RegExp(`^/(${locales.join("|")})(?=/|$)`);

// The pages that moved under /admin. Matched only behind a real locale: a bare
// first segment would also match `api`, which once sent /api/users/<id>/card to
// a non-existent /api/admin/users/... route.
const MOVED_TO_ADMIN = /^\/(users|jira|activity)(?=\/|$)/;

// The project URLs that predate the root namespace (`/[KEY]`): `/project/<key>`
// (singular, with an issue number or any sub-path after it) and
// `/projects/<key>[/...]`; `/projects/new` was the flat create-environment page.
// `/projects/<uuid>` is an environment from before readable URLs: it needs a
// lookup, so the page route `projects.$key` answers it, not this table.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_PROJECT = /^\/(project|projects)\/([^/]+)((?:\/.*)?)$/;

// Never pages: the API, the favicon and the built, hashed assets.
const NOT_PAGES = /^\/(api|brand|assets)(?=\/|$)/;

export type Redirect = { to: string; status: 301 | 302 | 308 };

/**
 * Where `pathname` should go instead, or null when it is already the page's
 * own URL. The caller carries the query string over.
 *
 * `locale` is where a path without one goes: the caller's pick from the
 * visitor's preference (the server's from the NEXT_LOCALE cookie, then
 * Accept-Language). Pure, so the server and the browser share it.
 */
export function resolveRedirect(
  pathname: string,
  locale: Locale = defaultLocale
): Redirect | null {
  if (NOT_PAGES.test(pathname)) return null;

  const match = pathname.match(LOCALE_PREFIX);
  if (!match) {
    // No locale: the preferred one, as next-intl's `localePrefix: "always"`
    // chose it. Temporary, so a later language preference can still change it.
    const path = pathname === "/" ? "" : pathname;
    return { to: `/${locale}${path}`, status: 302 };
  }

  const current = match[1];
  const stripped = pathname.slice(match[0].length) || "/";

  // Temporary like the next.config.ts rule it replaces (permanent: false).
  if (MOVED_TO_ADMIN.test(stripped)) {
    return { to: `/${current}/admin${stripped}`, status: 302 };
  }

  const legacy = legacyProjectPath(stripped);
  if (legacy) return { to: `/${current}${legacy}`, status: 308 };

  // Permanent, as in proxy.ts: the casing of a project URL never changes back.
  const canonical = canonicalProjectPath(stripped);
  if (canonical) return { to: `/${current}${canonical}`, status: 308 };

  return null;
}

/**
 * Where an old project URL (locale-stripped) lives now, or null when the path
 * is not one. The port of the app/[locale]/project and app/[locale]/projects
 * redirect shims.
 */
function legacyProjectPath(stripped: string): string | null {
  const match = stripped.match(LEGACY_PROJECT);
  if (!match) return null;
  const [, prefix = "", key = "", tail = ""] = match;
  if (prefix === "projects") {
    if (key === "new" && tail === "") return "/environments/new";
    // An environment id: the page route resolves it.
    if (UUID.test(key)) return null;
  }
  // `/project/KEY/42` was an issue permalink; anything else keeps its path.
  const rest = tail.replace(/^\//, "");
  const path =
    prefix === "project" && /^\d+(?=\/|$)/.test(rest) ? `issues/${rest}` : rest;
  return `/${key.toUpperCase()}${path ? `/${path}` : ""}`;
}
