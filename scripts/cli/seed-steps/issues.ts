// Labels, milestones, issues with their comments and labels, the activity a
// person creating them would leave, and assignment notifications for the
// sign-in accounts.
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  issueComments,
  issueLabels,
  issues,
  labels,
  milestones,
  notifications,
} from "@/lib/db/schema";
import {
  DEMO_LABELS,
  DEMO_PROJECT_ISSUES,
  type DemoIssue,
  MILESTONES,
  PROJECT_ISSUES,
} from "../seed-data/issues";
import { addDays, addMinutes, notAfter, workTime } from "../seed-data/random";
import { count, personId, type SeedContext } from "./context";

// Who gets an in-app notice when assigned: the people who can sign in.
const NOTIFIED = new Set(["demo-engineer", "demo-qa"]);

const ISSUES_BY_PROJECT: Record<string, readonly DemoIssue[]> = {
  DEMO: DEMO_PROJECT_ISSUES,
  DEMOPORTAL: DEMO_PROJECT_ISSUES,
  ...PROJECT_ISSUES,
};

export async function seedIssues(ctx: SeedContext): Promise<void> {
  const { tx, now } = ctx;
  const insertedLabels = await tx
    .insert(labels)
    .values(DEMO_LABELS.map((l) => ({ ...l })))
    .onConflictDoNothing()
    .returning({ id: labels.id });
  count(ctx, "labels", insertedLabels.length);
  const labelRows = await tx
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(
      inArray(
        labels.name,
        DEMO_LABELS.map((l) => l.name)
      )
    );
  const labelIds = new Map(labelRows.map((l) => [l.name, l.id]));

  for (const [key, list] of Object.entries(ISSUES_BY_PROJECT)) {
    const project = ctx.projects.get(key);
    if (!project) continue;
    const milestoneIds = await seedMilestones(ctx, key, project.id);
    // Issues created now, by number: children link only to a parent that
    // is demo data too.
    const created = new Map<number, string>();
    for (const issue of list) {
      const createdAt =
        issue.daysAgo === undefined
          ? undefined
          : workTime(now, issue.daysAgo, (issue.number * 37) % 420);
      const thread = (issue.comments ?? []).map((c) => ({
        ...c,
        at: notAfter(addMinutes(createdAt ?? now, c.afterHours * 60), now),
      }));
      const lastTouch = thread.at(-1)?.at ?? createdAt;
      const done = issue.status === "resolved" || issue.status === "closed";
      const updatedAt =
        createdAt && lastTouch
          ? notAfter(done ? addDays(lastTouch, 1) : lastTouch, now)
          : undefined;
      const createdById = personId(ctx, issue.createdBy);
      const assigneeId = personId(ctx, issue.assignee);
      const [row] = await tx
        .insert(issues)
        .values({
          projectId: project.id,
          number: issue.number,
          title: issue.title,
          description: issue.description ?? "",
          status: issue.status,
          type: issue.type,
          priority: issue.priority,
          estimate: issue.estimate ?? null,
          parentId: issue.parent ? (created.get(issue.parent) ?? null) : null,
          milestoneId: issue.milestone
            ? (milestoneIds.get(issue.milestone) ?? null)
            : null,
          environmentId: issue.environment
            ? (ctx.environments.get(`${key}/${issue.environment}`)?.id ?? null)
            : null,
          createdById,
          assigneeId,
          ...(createdAt ? { createdAt } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: issues.id });
      if (!row) continue;
      count(ctx, "issues");
      created.set(issue.number, row.id);
      const issueKey = `${key}-${issue.number}`;

      const labelValues = (issue.labels ?? []).flatMap((name) => {
        const labelId = labelIds.get(name);
        return labelId ? [{ issueId: row.id, labelId }] : [];
      });
      if (labelValues.length > 0) {
        await tx.insert(issueLabels).values(labelValues).onConflictDoNothing();
        count(ctx, "issueLabels", labelValues.length);
      }

      const comments = thread.flatMap((c) => {
        const authorId = personId(ctx, c.author);
        return authorId
          ? [{ issueId: row.id, authorId, body: c.body, createdAt: c.at }]
          : [];
      });
      if (comments.length > 0) {
        await tx.insert(issueComments).values(comments);
        count(ctx, "comments", comments.length);
      }

      // The entries server/services/issues writes on create and on a status
      // change. Comments write none.
      if (createdById && createdAt) {
        await tx.insert(activityLog).values({
          actorId: createdById,
          action: "issue.created",
          entityType: "issue",
          entityId: row.id,
          data: { key: issueKey, title: issue.title },
          createdAt,
        });
        count(ctx, "activity");
      }
      if (done && updatedAt && (assigneeId ?? createdById)) {
        await tx.insert(activityLog).values({
          actorId: assigneeId ?? createdById,
          action: "issue.status_changed",
          entityType: "issue",
          entityId: row.id,
          data: { key: issueKey, status: issue.status },
          createdAt: updatedAt,
        });
        count(ctx, "activity");
      }

      // lib/notifications notifyIssueAssigned: no notice for self-assignment.
      if (
        issue.assignee &&
        NOTIFIED.has(issue.assignee) &&
        assigneeId &&
        assigneeId !== createdById
      ) {
        const at = createdAt ?? now;
        await tx.insert(notifications).values({
          userId: assigneeId,
          type: "issue_assigned",
          data: { key, number: issue.number, title: issue.title },
          href: `/${key}/issues/${issue.number}`,
          // Older ones were opened already.
          readAt: done ? addMinutes(at, 90) : null,
          createdAt: at,
        });
        count(ctx, "notifications");
      }
    }
  }
}

/** The project's two milestones, looked up by name and added when missing. */
async function seedMilestones(
  ctx: SeedContext,
  key: string,
  projectId: string
): Promise<Map<string, string>> {
  const { tx, now } = ctx;
  const ids = new Map<string, string>();
  for (const milestone of MILESTONES[key] ?? []) {
    const [existing] = await tx
      .select({ id: milestones.id })
      .from(milestones)
      .where(
        and(
          eq(milestones.projectId, projectId),
          eq(milestones.name, milestone.name)
        )
      );
    if (existing) {
      ids.set(milestone.slot, existing.id);
      continue;
    }
    const due = addDays(now, milestone.dueInDays);
    due.setUTCHours(10, 0, 0, 0);
    const [row] = await tx
      .insert(milestones)
      .values({
        projectId,
        name: milestone.name,
        description: milestone.description,
        // The past one is overdue and still open, as it shows in the UI.
        dueAt: due,
        createdAt: addDays(now, -32),
      })
      .returning({ id: milestones.id });
    if (!row) continue;
    count(ctx, "milestones");
    ids.set(milestone.slot, row.id);
  }
  return ids;
}
