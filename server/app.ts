import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { auth } from "@/lib/auth";
import type { AppEnv } from "@/server/context";
import { onError } from "@/server/errors";
import { locale } from "@/server/middleware/locale";
import { securityHeaders } from "@/server/middleware/security-headers";

/**
 * A Hono instance with the stack every request goes through. Order matters:
 * `contextStorage` first so everything after it — including the error handler —
 * can reach the request through server/context; security headers next so they
 * wrap every response; then the locale, which handlers read via `getLocale()`.
 *
 * Exported so tests can mount a probe route on the exact production stack.
 */
export function createBaseApp() {
  return new Hono<AppEnv>()
    .use(contextStorage())
    .use(securityHeaders)
    .use(locale)
    .onError(onError);
}

export const app = createBaseApp()
  // better-auth owns everything under /api/auth and sets its cookies on the
  // Response it returns, so it gets the raw request and nothing else.
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  .get("/api/health", (c) => c.json({ ok: true }));

export type AppType = typeof app;
