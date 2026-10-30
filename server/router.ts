import { Hono } from "hono";
import { requireSession } from "@/lib/auth-session";
import type { AppEnv } from "@/server/context";

// Every router under server/routes starts from one of these two factories
// (tests/authz-guards.test.ts enforces it), so whether a route needs a session
// is decided once per router rather than remembered per handler.

/**
 * A router whose every route needs a signed-in user. The session check runs
 * before validation and before the handler, so a signed-out caller gets a 401
 * without learning the payload shape and no route reaches the database first.
 * Finer permissions stay where they were: the service guard, or the route
 * itself when it reads straight from lib/.
 *
 * Mounted with `app.route(prefix, router)`, the check covers `prefix/*` — so a
 * public route must never share a prefix with a session router.
 */
export function sessionRouter() {
  return new Hono<AppEnv>().use(async (_c, next) => {
    await requireSession();
    await next();
  });
}

/**
 * A router reachable without a session: the boot payload, `/api/me`, and the
 * onboarding steps that run before an account exists. Keep this list short —
 * the guard test pins which files may create one.
 */
export function publicRouter() {
  return new Hono<AppEnv>();
}
