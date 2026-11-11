import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { auth } from "@/lib/auth";
import { OPSDECK_VERSION } from "@/lib/version";
import type { AppEnv } from "@/server/context";
import { onError } from "@/server/errors";
import { csrfGuard } from "@/server/middleware/csrf";
import { locale } from "@/server/middleware/locale";
import { securityHeaders } from "@/server/middleware/security-headers";
import { accessRouter } from "@/server/routes/access";
import { activityRouter } from "@/server/routes/activity";
import { appsRouter } from "@/server/routes/apps";
import { backupsRouter } from "@/server/routes/backups";
import { brandRouter } from "@/server/routes/brand";
import { ciConnectionsRouter } from "@/server/routes/ci-connections";
import { cloudflareAccountRouter } from "@/server/routes/cloudflare-account";
import { databaseHostsRouter } from "@/server/routes/database-hosts";
import { databasesRouter } from "@/server/routes/databases";
import { deployHooksRouter } from "@/server/routes/deploy-hooks";
import { deployLocksRouter } from "@/server/routes/deploy-locks";
import { deploysRouter } from "@/server/routes/deploys";
import { environmentArchivesRouter } from "@/server/routes/environment-archives";
import { environmentDomainsRouter } from "@/server/routes/environment-domains";
import { environmentsRouter } from "@/server/routes/environments";
import { explorerRouter } from "@/server/routes/explorer";
import { homeRouter } from "@/server/routes/home";
import { instanceRouter, instanceSshKeyRouter } from "@/server/routes/instance";
import {
  issueAttachmentFilesRouter,
  issueAttachmentsRouter,
} from "@/server/routes/issue-attachments";
import { issuesRouter } from "@/server/routes/issues";
import { jiraRouter, jiraWebhookRouter } from "@/server/routes/jira";
import { knowledgeRouter } from "@/server/routes/knowledge";
import { labelsRouter } from "@/server/routes/labels";
import { mailFilesRouter, mailRouter } from "@/server/routes/mail";
import { mailpitSettingsRouter } from "@/server/routes/mailpit-settings";
import { milestonesRouter } from "@/server/routes/milestones";
import { mockTimeRouter } from "@/server/routes/mock-time";
import { notificationsRouter } from "@/server/routes/notifications";
import { avatarsRouter, profileRouter } from "@/server/routes/profile";
import { projectCatalogRouter } from "@/server/routes/project-catalog";
import { projectMembersRouter } from "@/server/routes/project-members";
import { provisioningRouter } from "@/server/routes/provisioning";
import {
  environmentReleasesRouter,
  projectReleasesRouter,
  releasesRouter,
} from "@/server/routes/releases";
import { remoteTunnelsRouter } from "@/server/routes/remote-tunnels";
import { runsRouter } from "@/server/routes/runs";
import { s3ConnectionsRouter } from "@/server/routes/s3-connections";
import { savedViewsRouter } from "@/server/routes/saved-views";
import { serversRouter } from "@/server/routes/servers";
import { serviceLogsRouter, servicesRouter } from "@/server/routes/services";
import { sessionInfoRouter } from "@/server/routes/session";
import { setupRouter } from "@/server/routes/setup";
import { terminalRouter } from "@/server/routes/terminal";
import { testRunsRouter } from "@/server/routes/test-runs";
import { tunnelsRouter } from "@/server/routes/tunnels";
import { onboardingRouter, usersRouter } from "@/server/routes/users";
import {
  environmentVariablesRouter,
  variableTemplatesRouter,
} from "@/server/routes/variables";

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
  .get("/api/health", (c) => c.json({ ok: true, version: OPSDECK_VERSION }))
  // One chain, so AppType carries every route for the typed client. Each
  // module router is mounted at /api/<module>; the extra mounts keep the paths
  // of handlers ported from app/api (/api/issues/..., /api/avatars/...,
  // /api/environments/:id/mail/..., /api/runs/:id/stream).
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
  .route("/api/project-catalog", projectCatalogRouter)
  .route("/api/environments", environmentsRouter)
  .route("/api/environments", mailFilesRouter)
  .route("/api/environments", serviceLogsRouter)
  .route("/api/environments", environmentVariablesRouter)
  .route("/api/environments", deployLocksRouter)
  .route("/api/environments", provisioningRouter)
  .route("/api/environments", environmentDomainsRouter)
  .route("/api/remote-tunnels", remoteTunnelsRouter)
  .route("/api/services", servicesRouter)
  .route("/api/runs", runsRouter)
  .route("/api/backups", backupsRouter)
  .route("/api/databases", databasesRouter)
  .route("/api/database-hosts", databaseHostsRouter)
  .route("/api/mail", mailRouter)
  .route("/api/mailpit-settings", mailpitSettingsRouter)
  .route("/api/mock-time", mockTimeRouter)
  .route("/api/test-runs", testRunsRouter)
  .route("/api/servers", serversRouter)
  .route("/api/s3-connections", s3ConnectionsRouter)
  .route("/api/explorer", explorerRouter)
  .route("/api/tunnels", tunnelsRouter)
  .route("/api/terminal", terminalRouter)
  // The Jira session router sits under /api/integrations so nothing gated
  // shares a prefix with the public webhook (see server/router.ts).
  .route("/api/integrations/jira", jiraRouter)
  .route("/api/jira/webhook", jiraWebhookRouter)
  // Public, HMAC-signed CI build notifications; no session router shares
  // this prefix.
  .route("/api/deploy-hooks", deployHooksRouter)
  .route("/api/deploys", deploysRouter)
  .route("/api/environments", environmentReleasesRouter)
  .route("/api/projects", projectReleasesRouter)
  .route("/api/releases", releasesRouter)
  .route("/api/apps", appsRouter)
  .route("/api/setup", setupRouter)
  .route("/api/apps", variableTemplatesRouter)
  .route("/api/ci-connections", ciConnectionsRouter)
  .route("/api/cloudflare-account", cloudflareAccountRouter)
  // Before /api/instance: its instance:manage guard would answer first.
  .route("/api/instance/ssh-key", instanceSshKeyRouter)
  .route("/api/instance/environment-archives", environmentArchivesRouter)
  .route("/api/instance", instanceRouter)
  // The favicon keeps its pre-API path; the SPA's <link rel="icon"> uses it.
  .route("/brand", brandRouter);

export type AppType = typeof app;
