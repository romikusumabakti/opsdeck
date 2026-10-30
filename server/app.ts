import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { auth } from "@/lib/auth";
import type { AppEnv } from "@/server/context";
import { onError } from "@/server/errors";
import { csrfGuard } from "@/server/middleware/csrf";
import { locale } from "@/server/middleware/locale";
import { securityHeaders } from "@/server/middleware/security-headers";
import { accessRouter } from "@/server/routes/access";
import { activityRouter } from "@/server/routes/activity";
import { homeRouter } from "@/server/routes/home";
import {
  issueAttachmentFilesRouter,
  issueAttachmentsRouter,
} from "@/server/routes/issue-attachments";
import { issuesRouter } from "@/server/routes/issues";
import { knowledgeRouter } from "@/server/routes/knowledge";
import { labelsRouter } from "@/server/routes/labels";
import { milestonesRouter } from "@/server/routes/milestones";
import { notificationsRouter } from "@/server/routes/notifications";
import { avatarsRouter, profileRouter } from "@/server/routes/profile";
import { projectCatalogRouter } from "@/server/routes/project-catalog";
import { projectMembersRouter } from "@/server/routes/project-members";
import { savedViewsRouter } from "@/server/routes/saved-views";
import { sessionInfoRouter } from "@/server/routes/session";
import { onboardingRouter, usersRouter } from "@/server/routes/users";

/**
 * A Hono instance with the stack every request goes through. Order matters:
 * `contextStorage` first so everything after it — including the error handler —
 * can reach the request through server/context; security headers next so they
 * wrap every response, the CSRF refusal included; the CSRF check before
 * anything reads a body or a session; then the locale, which handlers read via
 * `getLocale()`.
 *
 * Exported so tests can mount a probe route on the exact production stack.
 */
export function createBaseApp() {
  return new Hono<AppEnv>()
    .use(contextStorage())
    .use(securityHeaders)
    .use(csrfGuard)
    .use(locale)
    .onError(onError);
}

export const app = createBaseApp()
  // better-auth owns everything under /api/auth and sets its cookies on the
  // Response it returns, so it gets the raw request and nothing else.
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  .get("/api/health", (c) => c.json({ ok: true }))
  // One chain, so AppType carries every route for the typed client. Each
  // module router is mounted at /api/<module>; the extra mounts keep the paths
  // of handlers ported from app/api (/api/issues/..., /api/avatars/...).
  .route("/api", sessionInfoRouter)
  .route("/api/onboarding", onboardingRouter)
  .route("/api/issues", issuesRouter)
  .route("/api/issues", issueAttachmentFilesRouter)
  .route("/api/issue-attachments", issueAttachmentsRouter)
  .route("/api/labels", labelsRouter)
  .route("/api/milestones", milestonesRouter)
  .route("/api/saved-views", savedViewsRouter)
  .route("/api/notifications", notificationsRouter)
  .route("/api/home", homeRouter)
  .route("/api/activity", activityRouter)
  .route("/api/knowledge", knowledgeRouter)
  .route("/api/users", usersRouter)
  .route("/api/profile", profileRouter)
  .route("/api/avatars", avatarsRouter)
  .route("/api/access", accessRouter)
  .route("/api/project-members", projectMembersRouter)
  .route("/api/project-catalog", projectCatalogRouter);

export type AppType = typeof app;
