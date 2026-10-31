import { db } from "@/lib/db";
import { type NewNotification, notifications } from "@/lib/db/schema";

// SERVER-ONLY write helpers. Emitting a notification must never break the action
// that triggered it, so failures are logged and swallowed.
async function createNotification(
  input: Pick<NewNotification, "userId" | "type" | "data" | "href">
): Promise<void> {
  try {
    await db.insert(notifications).values(input);
  } catch (error) {
    console.error("Failed to create notification:", error);
  }
}

/** Notify the assignee of an issue. No-op for self-assignment or no assignee. */
export async function notifyIssueAssigned(input: {
  assigneeId: string | null | undefined;
  actorId: string;
  projectKey: string;
  number: number;
  title: string;
}): Promise<void> {
  if (!input.assigneeId || input.assigneeId === input.actorId) return;
  await createNotification({
    userId: input.assigneeId,
    type: "issue_assigned",
    data: { key: input.projectKey, number: input.number, title: input.title },
    href: `/${input.projectKey}/issues/${input.number}`,
  });
}

/** Notify a user mentioned in an issue comment. No-op for self-mention. */
export async function notifyIssueMention(input: {
  userId: string;
  actorId: string;
  projectKey: string;
  number: number;
  title: string;
}): Promise<void> {
  if (input.userId === input.actorId) return;
  await createNotification({
    userId: input.userId,
    type: "issue_mention",
    data: { key: input.projectKey, number: input.number, title: input.title },
    href: `/${input.projectKey}/issues/${input.number}`,
  });
}

/** Notify the user who initiated a run when it fails. */
export async function notifyRunFailed(input: {
  userId: string | null | undefined;
  projectKey: string;
  envSlug: string;
  environmentName: string;
  description: string;
}): Promise<void> {
  if (!input.userId) return;
  await createNotification({
    userId: input.userId,
    type: "run_failed",
    data: {
      environment: input.environmentName,
      description: input.description,
    },
    href: `/${input.projectKey}/${input.envSlug}/history`,
  });
}

/**
 * Tell the editor that their change didn't reach Jira. The push runs in a
 * background job, so by the time Jira refuses the edit the user has moved on.
 */
export async function notifyJiraPushFailed(input: {
  userId: string | null | undefined;
  projectKey: string;
  number: number;
  fields: string;
  reason: "conflict" | "no_transition" | "no_matching_value";
}): Promise<void> {
  if (!input.userId) return;
  await createNotification({
    userId: input.userId,
    type: "jira_push_failed",
    data: {
      key: input.projectKey,
      number: input.number,
      fields: input.fields,
      reason: input.reason,
    },
    href: `/${input.projectKey}/issues/${input.number}`,
  });
}
