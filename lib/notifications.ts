import "server-only";

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
    href: `/project/${input.projectKey}`,
  });
}

/** Notify the user who initiated a run when it fails. */
export async function notifyRunFailed(input: {
  userId: string | null | undefined;
  environmentId: string;
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
    href: `/projects/${input.environmentId}/history`,
  });
}
