import type { Context } from "hono";
import { tryGetContext } from "hono/context-storage";
import { defaultLocale, type Locale } from "@/i18n/locales";
import { auth } from "@/lib/auth";

// Request-scoped state without threading `c` through every call.
//
// `contextStorage()` (applied first in server/app.ts) runs each request inside
// an AsyncLocalStorage holding its Hono Context, so a helper five awaits deep —
// `requireSession()`, `getLocale()`, a guard in lib/authz — can read the request
// it belongs to. That keeps the ~180 existing guard call sites unchanged.
//
// The same modules are also imported by code that never runs inside a request:
// the BullMQ worker (lib/jobs) and the terminal sidecar (lib/terminal). There
// the store is empty, and each accessor below says what it falls back to rather
// than crashing at import time.

export type AppEnv = {
  Variables: {
    // Set by server/middleware/locale.ts on every request.
    locale: Locale;
  };
};

function currentContext(): Context<AppEnv> | undefined {
  return tryGetContext<AppEnv>();
}

/** The incoming request's headers. Throws outside a request. */
export function getRequestHeaders(): Headers {
  const c = currentContext();
  if (!c) {
    throw new Error(
      "getRequestHeaders() called outside a request — no request context is active"
    );
  }
  return c.req.raw.headers;
}

/** The request's locale; the default locale outside a request. */
export function getLocale(): Locale {
  return currentContext()?.var.locale ?? defaultLocale;
}

type Primitive = string | number | boolean | null | undefined;

/**
 * Memoize `fn` for the lifetime of one request — the job React's `cache` did
 * under Next. Results are keyed by the Context object in a WeakMap, so they are
 * dropped with the request and concurrent requests never share an entry.
 * Arguments must be primitives: they are compared by value. Outside a request
 * nothing is memoized and `fn` runs on every call.
 *
 * A rejected promise stays memoized for the rest of the request, as with
 * `cache`: retrying inside the same request would hit the same failure.
 */
export function requestCache<A extends Primitive[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const perRequest = new WeakMap<Context, Map<string, R>>();
  return (...args) => {
    const c = currentContext();
    if (!c) return fn(...args);
    let memo = perRequest.get(c);
    if (!memo) {
      memo = new Map();
      perRequest.set(c, memo);
    }
    const key = JSON.stringify(args);
    if (!memo.has(key)) memo.set(key, fn(...args));
    return memo.get(key) as R;
  };
}

/**
 * The current session, memoized for the lifetime of one request; `null` when
 * signed out and outside a request (so guards treat background code as
 * unauthenticated).
 *
 * `auth.api.getSession` re-parses the cookie and re-reads the `sessions` row on
 * every call, and this is reached from ~180 sites — one API request fans out
 * through services and data helpers that each call `requireSession()` on their
 * own. Without the memo that is a fresh round-trip per call for an answer that
 * cannot change mid-request.
 *
 * NOT the same thing as better-auth's `session.cookieCache`, which is
 * deliberately left off: that caches across requests in a signed cookie, so a
 * revoked session (account > sessions) or a ban would keep working until the
 * cookie's TTL expired. This memo has no such window.
 */
export const getServerSession = requestCache(async () => {
  const c = currentContext();
  if (!c) return null;
  return auth.api.getSession({ headers: c.req.raw.headers });
});
