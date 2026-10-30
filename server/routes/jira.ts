import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { jiraConnections } from "@/lib/db/schema";
import { enqueue } from "@/lib/queue";
import {
  jiraConnectionInputSchema,
  jiraConnectionUpdateSchema,
  jiraFlavorSchema,
  jiraProjectLinkSchema,
  uuidSchema,
} from "@/lib/validation";
import { publicRouter, sessionRouter } from "@/server/router";
import {
  createJiraConnection,
  deleteJiraConnection,
  getJiraConnection,
  getJiraConnections,
  getJiraLink,
  getJiraWebhookUrl,
  saveJiraLink,
  syncJiraProjectNow,
  testJiraConnection,
  unlinkJiraProject,
  updateJiraConnection,
} from "@/server/services/jira";
import { json, query } from "@/server/validation";

const projectIdBody = json(z.object({ projectId: uuidSchema }));

/**
 * Jira site management and per-project linking. Mounted at
 * /api/integrations/jira, not /api/jira: the webhook below must stay at
 * /api/jira/webhook/:token without a session, and a session router mounted
 * over /api/jira would gate it.
 */
export const jiraRouter = sessionRouter()
  .get("/get-jira-connections", async (c) => c.json(await getJiraConnections()))
  .get("/get-jira-connection", query(z.object({ id: uuidSchema })), async (c) =>
    c.json((await getJiraConnection(c.req.valid("query").id)) ?? null)
  )
  .get(
    "/get-jira-webhook-url",
    query(z.object({ connectionId: uuidSchema })),
    async (c) =>
      c.json(await getJiraWebhookUrl(c.req.valid("query").connectionId))
  )
  .get(
    "/get-jira-link",
    query(z.object({ projectId: uuidSchema })),
    async (c) => c.json(await getJiraLink(c.req.valid("query").projectId))
  )
  .post(
    "/create-jira-connection",
    json(z.object({ data: jiraConnectionInputSchema })),
    async (c) => c.json(await createJiraConnection(c.req.valid("json").data))
  )
  .post(
    "/update-jira-connection",
    json(z.object({ id: uuidSchema, data: jiraConnectionUpdateSchema })),
    async (c) => {
      const { id, data } = c.req.valid("json");
      return c.json(await updateJiraConnection(id, data));
    }
  )
  .post(
    "/delete-jira-connection",
    json(z.object({ id: uuidSchema })),
    async (c) => c.json(await deleteJiraConnection(c.req.valid("json").id))
  )
  .post(
    "/test-jira-connection",
    // A probe of unsaved form values: Jira's answer is the message.
    json(
      z.object({
        input: z.object({
          baseUrl: z.string().max(2048),
          flavor: jiraFlavorSchema,
          email: z.string().max(320).nullish(),
          apiToken: z.string().max(2048).optional(),
          connectionId: uuidSchema.optional(),
        }),
      })
    ),
    async (c) => c.json(await testJiraConnection(c.req.valid("json").input))
  )
  .post(
    "/save-jira-link",
    json(z.object({ data: jiraProjectLinkSchema })),
    async (c) => c.json(await saveJiraLink(c.req.valid("json").data))
  )
  .post("/unlink-jira-project", projectIdBody, async (c) =>
    c.json(await unlinkJiraProject(c.req.valid("json").projectId))
  )
  .post(
    "/sync-jira-project-now",
    json(z.object({ projectId: uuidSchema, full: z.boolean().optional() })),
    async (c) => {
      const { projectId, full } = c.req.valid("json");
      return c.json(await syncJiraProjectNow(projectId, full));
    }
  );

// Events worth acting on. Everything else (worklogs, sprints, project config)
// is out of scope and acked without work.
const HANDLED = new Set([
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "comment_updated",
  "comment_deleted",
]);

/** Constant-time compare that tolerates differing lengths. */
function secretMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Jira webhook receiver, ported from app/api/jira/webhook/[token]. Public:
 * Jira calls it with no session.
 *
 * Authentication is the URL itself. Jira Cloud's system webhooks cannot sign a
 * request body or send a custom header, so an unguessable path segment (24
 * random bytes, generated per connection) compared in constant time is the
 * mechanism available. That is a weaker guarantee than an HMAC, and the design
 * accounts for it: the payload is never read as data. Only `issue.id` is taken
 * from it, and the sync job re-fetches that issue from the Jira API with our
 * own credentials. A leaked URL therefore buys an attacker a forced re-sync of
 * an issue that already exists — not the ability to inject or alter anything.
 *
 * (It does mean the secret appears in the reverse proxy's access log. Either
 * exclude this path from logging or accept it, per the deploy notes.)
 *
 * Jira posts `application/json`, which the app's CSRF check does not inspect
 * (an HTML form can't send it), so the webhook needs no exemption there.
 *
 * The handler acks immediately and does the work on the queue. Jira treats a
 * slow endpoint as a failing one and will disable a webhook that keeps timing
 * out, so nothing here may wait on the Jira API.
 */
export const jiraWebhookRouter = publicRouter().post("/:token", async (c) => {
  const token = c.req.param("token");
  if (!token || token.length < 16) {
    return c.json({ error: "not found" }, 404);
  }

  // Load candidates and compare in constant time. Indexing the secret and
  // querying by it would leak the comparison to the database's own equality
  // test; the connection count is a handful, so a scan is free.
  const connections = await db
    .select({ id: jiraConnections.id, secret: jiraConnections.webhookSecret })
    .from(jiraConnections);
  const connection = connections.find((row) =>
    secretMatches(token, row.secret)
  );
  if (!connection) {
    return c.json({ error: "not found" }, 404);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }

  const event = payload as {
    webhookEvent?: string;
    issue?: { id?: string };
  } | null;
  if (!event?.webhookEvent || !HANDLED.has(event.webhookEvent)) {
    return c.json({ ignored: true });
  }
  const jiraIssueId = event.issue?.id;
  if (!jiraIssueId) {
    // Comment events always carry their issue; anything without one has
    // nothing for us to re-fetch.
    return c.json({ ignored: true });
  }

  await enqueue(
    "jira/issue.changed",
    { connectionId: connection.id, jiraIssueId },
    {
      // Idempotent (the applier skips a revision it already has), so retrying
      // a transient Jira 5xx is safe and is the point of the safety net.
      attempts: 3,
      backoffMs: 2_000,
      // Collapse the burst Jira sends when one edit changes several fields.
      jobId: `jira-issue-${connection.id}-${jiraIssueId}`,
    }
  );

  return c.json({ queued: true });
});
