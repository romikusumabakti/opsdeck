import { eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { issueComments, issues, projects, users } from "@/lib/db/schema";
import { notifyJiraPushFailed } from "@/lib/notifications";
import { markdownToRichText } from "./adf";
import { addAttribution } from "./attribution";
import { JiraClient, JiraError } from "./client";
import { priorityNameCandidates, targetCategoryFor } from "./mapping";
import { resolveLink } from "./sync";

/**
 * The push half: write a small, explicit allowlist of OpsDeck edits back to
 * Jira. Only runs for links with `pushEnabled` (off by default).
 *
 * Two rules keep this from becoming a merge engine:
 *
 *  1. **Jira wins.** If the remote issue moved since the revision we last
 *     applied, the local edit is discarded, recorded in the activity log as
 *     `issue.jira_conflict`, and the editor gets a `jira_push_failed`
 *     notification. There is no merge UI and no field-level reconcile.
 *  2. **Push reads current state.** The job payload names *which* fields
 *     changed, never their values, so a retried or delayed job writes what the
 *     issue says now instead of resurrecting a stale value.
 *
 * Echo suppression falls out of rule 2's epilogue: after a successful write we
 * store the remote's new `updated` in `jiraUpdatedAt`, so the webhook our own
 * push triggers hits the stale-skip in ./sync.ts and does nothing.
 */

/** The only fields OpsDeck is allowed to write back. */
export type PushableField =
  | "title"
  | "description"
  | "status"
  | "priority"
  | "assignee";

export type PushResult =
  | { pushed: true; fields: PushableField[] }
  | { pushed: false; reason: "not-linked" | "push-disabled" | "conflict" };

type PushFailureReason = "conflict" | "no_transition" | "no_matching_value";

/** Record a refused push in the activity log and tell the editor. */
type ReportFailure = (
  fields: PushableField[],
  reason: PushFailureReason,
  data?: Record<string, string>
) => Promise<void>;

export async function pushIssue(
  issueId: string,
  fields: PushableField[],
  actorId?: string
): Promise<PushResult> {
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue?.jiraIssueId) return { pushed: false, reason: "not-linked" };

  const resolved = await resolveLink(issue.projectId);
  if (!resolved) return { pushed: false, reason: "not-linked" };
  if (!(resolved.link.enabled && resolved.link.pushEnabled)) {
    return { pushed: false, reason: "push-disabled" };
  }

  const [project] = await db
    .select({ key: projects.key })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  const projectKey = project?.key ?? "";
  const report: ReportFailure = async (failed, reason, data = {}) => {
    await recordActivity({
      action:
        reason === "conflict"
          ? "issue.jira_conflict"
          : "issue.jira_push_failed",
      entityType: "issue",
      entityId: issue.id,
      data: {
        key: `${projectKey}-${issue.number}`,
        fields: failed.join(", "),
        reason,
        ...data,
      },
    });
    await notifyJiraPushFailed({
      userId: actorId,
      projectKey,
      number: issue.number,
      fields: failed.join(", "),
      reason,
    });
  };

  const client = new JiraClient(resolved.credentials);
  const before = await client.getIssue(issue.jiraIssueId);

  // Rule 1. Compare against what we last *applied*, not against `updatedAt`:
  // that is the only value that tells us whether Jira has moved underneath us.
  const remoteUpdated = new Date(before.fields.updated);
  if (
    issue.jiraUpdatedAt &&
    remoteUpdated.getTime() > issue.jiraUpdatedAt.getTime()
  ) {
    await report(fields, "conflict");
    return { pushed: false, reason: "conflict" };
  }

  const flavor = resolved.connection.flavor;
  const payload: Record<string, unknown> = {};
  if (fields.includes("title")) payload.summary = issue.title;
  if (fields.includes("description")) {
    payload.description = markdownToRichText(issue.description, flavor);
  }
  if (Object.keys(payload).length > 0) {
    await client.updateIssueFields(issue.jiraIssueId, payload);
  }

  if (fields.includes("priority")) {
    await pushPriority(client, issue.jiraIssueId, issue.priority, report);
  }

  if (fields.includes("assignee")) {
    await pushAssignee(client, issue.jiraIssueId, issue.assigneeId);
  }
  if (fields.includes("status")) {
    await pushStatus(client, issue.jiraIssueId, issue.status, report);
  }

  // Epilogue: adopt the revision our own write produced, so its webhook echo
  // is a no-op on the way back in.
  const after = await client.getIssue(issue.jiraIssueId);
  await db
    .update(issues)
    .set({
      jiraKey: after.key,
      jiraUpdatedAt: new Date(after.fields.updated),
      jiraSyncedAt: new Date(),
    })
    .where(eq(issues.id, issue.id));

  return { pushed: true, fields };
}

/**
 * Set the remote priority.
 *
 * `priority` is a per-project select whose allowed names vary (Highest/Blocker/
 * Critical all mean "urgent" somewhere), and there is no cheap way to read the
 * project's scheme. So: try the known names for this priority in order and let
 * a 400 mean "that value doesn't exist here". Sent as its own request so a
 * rejected priority can't take the summary/description write down with it.
 */
async function pushPriority(
  client: JiraClient,
  jiraIssueId: string,
  priority: (typeof issues.$inferSelect)["priority"],
  report: ReportFailure
): Promise<void> {
  for (const name of priorityNameCandidates(priority)) {
    try {
      await client.updateIssueFields(jiraIssueId, { priority: { name } });
      return;
    } catch (error) {
      if (error instanceof JiraError && error.status === 400) continue;
      throw error;
    }
  }
  await report(["priority"], "no_matching_value", { target: priority });
}

async function pushAssignee(
  client: JiraClient,
  jiraIssueId: string,
  assigneeId: string | null
): Promise<void> {
  if (!assigneeId) {
    await client.assignIssue(jiraIssueId, null);
    return;
  }
  const [user] = await db
    .select({ jiraAccountId: users.jiraAccountId })
    .from(users)
    .where(eq(users.id, assigneeId))
    .limit(1);
  // No known Atlassian identity: leave the remote assignee alone rather than
  // unassigning someone in Jira because our mapping is incomplete.
  if (!user?.jiraAccountId) return;
  await client.assignIssue(jiraIssueId, user.jiraAccountId);
}

/**
 * Move the remote issue into the status *category* our status maps to.
 *
 * Matching on category rather than name is what makes this survive renamed and
 * translated workflows. If no available transition lands in that category the
 * push is reported as a failure and nothing is retried — a workflow that has
 * no path from here to there is a configuration fact, not a transient error.
 * Walking several transitions to get there is deliberately not attempted: it
 * would skip steps like review that the workflow puts in the way on purpose.
 */
async function pushStatus(
  client: JiraClient,
  jiraIssueId: string,
  status: (typeof issues.$inferSelect)["status"],
  report: ReportFailure
): Promise<void> {
  const target = targetCategoryFor(status);
  const transitions = await client.getTransitions(jiraIssueId);
  const match = transitions.find(
    (transition) => transition.to?.statusCategory?.key === target
  );
  if (!match) {
    await report(["status"], "no_transition", { target });
    return;
  }
  await client.transitionIssue(jiraIssueId, match.id);
}

/** Post an OpsDeck comment to Jira and remember the remote id it got. */
export async function pushComment(commentId: string): Promise<PushResult> {
  const [comment] = await db
    .select()
    .from(issueComments)
    .where(eq(issueComments.id, commentId))
    .limit(1);
  // A comment that already carries a remote id is a mirror of Jira's own — it
  // must never be posted back.
  if (!comment || comment.jiraCommentId) {
    return { pushed: false, reason: "not-linked" };
  }

  const [issue] = await db
    .select({
      jiraIssueId: issues.jiraIssueId,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(eq(issues.id, comment.issueId))
    .limit(1);
  if (!issue?.jiraIssueId) return { pushed: false, reason: "not-linked" };

  const resolved = await resolveLink(issue.projectId);
  if (!resolved) return { pushed: false, reason: "not-linked" };
  if (!(resolved.link.enabled && resolved.link.pushEnabled)) {
    return { pushed: false, reason: "push-disabled" };
  }

  // The connection posts as its token's owner, so name the real author.
  const [author] = comment.authorId
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, comment.authorId))
        .limit(1)
    : [];
  const body = author
    ? addAttribution(comment.body, author.name)
    : comment.body;

  const client = new JiraClient(resolved.credentials);
  const created = await client.addComment(
    issue.jiraIssueId,
    markdownToRichText(body, resolved.connection.flavor)
  );
  await db
    .update(issueComments)
    .set({ jiraCommentId: created.id })
    .where(eq(issueComments.id, comment.id));

  return { pushed: true, fields: [] };
}
