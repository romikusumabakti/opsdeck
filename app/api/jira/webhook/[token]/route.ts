import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jiraConnections } from "@/lib/db/schema";
import { enqueue } from "@/lib/queue";

/**
 * Jira webhook receiver.
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
 * The handler acks immediately and does the work on the queue. Jira treats a
 * slow endpoint as a failing one and will disable a webhook that keeps timing
 * out, so nothing here may wait on the Jira API.
 */

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
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
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const event = payload as {
    webhookEvent?: string;
    issue?: { id?: string };
  };
  if (!event.webhookEvent || !HANDLED.has(event.webhookEvent)) {
    return NextResponse.json({ ignored: true });
  }
  const jiraIssueId = event.issue?.id;
  if (!jiraIssueId) {
    // Comment events always carry their issue; anything without one has
    // nothing for us to re-fetch.
    return NextResponse.json({ ignored: true });
  }

  await enqueue(
    "jira/issue.changed",
    { connectionId: connection.id, jiraIssueId },
    {
      // Idempotent (the applier skips a revision it already has), so retrying a
      // transient Jira 5xx is safe and is the point of the safety net.
      attempts: 3,
      backoffMs: 2_000,
      // Collapse the burst Jira sends when one edit changes several fields.
      jobId: `jira-issue-${connection.id}-${jiraIssueId}`,
    }
  );

  return NextResponse.json({ queued: true });
}
