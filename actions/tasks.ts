"use server";

import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { type Task, tasks } from "@/lib/db/schema";

export type TaskWithUser = Task & {
  user: { id: string; name: string; email: string } | null;
};

export type RunningTask = Pick<
  Task,
  "id" | "projectId" | "description" | "runAt"
> & {
  project: { id: string; name: string } | null;
};

// Returns currently-running tasks across all projects, newest first. Used by
// the global header indicator so users can see and jump back into long
// background jobs (backup/restore/mock-time) even after dismissing the
// per-page dialog. Capped at 10 — more than that is a system-health issue,
// not a UX problem.
export type ProjectActivity = {
  status: Task["status"];
  runAt: Date;
};

/**
 * Returns a map of {projectId -> most recent task} so the projects list can
 * show an at-a-glance health dot per card. Uses Postgres `DISTINCT ON` —
 * cheaper than fetching the latest task per project in N round-trips.
 */
export async function getProjectsLastActivity(): Promise<
  Record<string, ProjectActivity>
> {
  try {
    const rows = await db
      .selectDistinctOn([tasks.projectId], {
        projectId: tasks.projectId,
        status: tasks.status,
        runAt: tasks.runAt,
      })
      .from(tasks)
      .orderBy(tasks.projectId, desc(tasks.runAt));
    const map: Record<string, ProjectActivity> = {};
    for (const row of rows) {
      map[row.projectId] = { status: row.status, runAt: row.runAt };
    }
    return map;
  } catch (error) {
    console.error("Failed to fetch project last-activity:", error);
    return {};
  }
}

export async function getRunningTasks(): Promise<RunningTask[]> {
  try {
    const rows = await db.query.tasks.findMany({
      where: { status: "started" },
      columns: {
        id: true,
        projectId: true,
        description: true,
        runAt: true,
      },
      with: {
        project: {
          columns: { id: true, name: true },
        },
      },
      orderBy: { runAt: "desc" },
      limit: 10,
    });
    return rows as RunningTask[];
  } catch (error) {
    console.error("Failed to fetch running tasks:", error);
    return [];
  }
}

export async function getProjectTasks(
  projectId: string
): Promise<TaskWithUser[]> {
  try {
    const rows = await db.query.tasks.findMany({
      where: { projectId },
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: { runAt: "desc" },
    });
    return rows as TaskWithUser[];
  } catch (error) {
    console.error(`Failed to fetch tasks for project ${projectId}:`, error);
    return [];
  }
}

export type TaskSnapshot = Pick<
  Task,
  | "id"
  | "projectId"
  | "description"
  | "status"
  | "output"
  | "errorMessage"
  | "runAt"
  | "completedAt"
>;

export async function getTaskSnapshot(
  taskId: string
): Promise<TaskSnapshot | null> {
  const row = await db.query.tasks.findFirst({
    where: { id: taskId },
    columns: {
      id: true,
      projectId: true,
      description: true,
      status: true,
      output: true,
      errorMessage: true,
      runAt: true,
      completedAt: true,
    },
  });
  return row ?? null;
}

export type KpiKind = "backup" | "restore" | "mock";

export type KpiEntry = {
  runAt: Date;
  status: Task["status"];
} | null;

export type ProjectKpis = {
  lastBackup: KpiEntry;
  lastRestore: KpiEntry;
  lastMock: KpiEntry;
  // Aggregate over the past 7 days. successRate is null if there were no
  // completed runs (avoids "0%" looking like a failure when it's just empty).
  totalRuns7d: number;
  successRate7d: number | null;
  // Run count for the previous 7-day window (days 8-14 ago). Used to show a
  // delta indicator on the activity KPI so users see direction at a glance.
  prevTotalRuns7d: number;
  // Daily run counts for the last 7 days, oldest-to-newest. dailyRuns[6] is
  // today. Drives the sparkline; UTC day boundaries keep the bucketing
  // deterministic regardless of viewer timezone.
  dailyRuns: number[];
};

// Description prefixes set by the action layer in actions/backups.ts and
// actions/mock-time.ts. Keeping the KPI grouping derived from these
// prefixes avoids a schema migration to add a "kind" column.
const KPI_PREFIX: Record<KpiKind, string> = {
  backup: "Backup database",
  restore: "Restore database",
  mock: "Mock time",
};

async function findLatestByKind(
  projectId: string,
  kind: KpiKind
): Promise<KpiEntry> {
  const [row] = await db
    .select({ runAt: tasks.runAt, status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        like(tasks.description, `${KPI_PREFIX[kind]}%`)
      )
    )
    .orderBy(sql`${tasks.runAt} DESC`)
    .limit(1);
  return row ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getProjectKpis(projectId: string): Promise<ProjectKpis> {
  // Pull 14 days so we can compute both the current 7d window (for the
  // existing total/success metrics + sparkline) and the prior 7d window
  // (for the delta indicator) in a single round-trip.
  const since14 = new Date(Date.now() - 14 * DAY_MS);

  try {
    const [lastBackup, lastRestore, lastMock, recent] = await Promise.all([
      findLatestByKind(projectId, "backup"),
      findLatestByKind(projectId, "restore"),
      findLatestByKind(projectId, "mock"),
      db
        .select({ status: tasks.status, runAt: tasks.runAt })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), gte(tasks.runAt, since14))),
    ]);

    // Bucket by UTC day-index relative to today. Day 0 = today, day 6 = a
    // week ago, day 13 = two weeks ago. dailyRuns is reversed at the end so
    // the sparkline reads left-to-right (oldest -> newest).
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const dailyRuns = new Array(7).fill(0);
    let totalRuns7d = 0;
    let prevTotalRuns7d = 0;
    const completedCurrent: { status: Task["status"] }[] = [];

    for (const row of recent) {
      const runDay = new Date(row.runAt);
      runDay.setUTCHours(0, 0, 0, 0);
      const daysBack = Math.floor(
        (todayStart.getTime() - runDay.getTime()) / DAY_MS
      );
      if (daysBack >= 0 && daysBack <= 6) {
        dailyRuns[6 - daysBack] += 1;
        totalRuns7d += 1;
        completedCurrent.push(row);
      } else if (daysBack >= 7 && daysBack <= 13) {
        prevTotalRuns7d += 1;
      }
    }

    const completed = completedCurrent.filter((r) => r.status !== "started");
    const successes = completed.filter((r) => r.status === "success").length;
    const successRate7d =
      completed.length === 0
        ? null
        : Math.round((successes / completed.length) * 100);

    return {
      lastBackup,
      lastRestore,
      lastMock,
      totalRuns7d,
      successRate7d,
      prevTotalRuns7d,
      dailyRuns,
    };
  } catch (error) {
    console.error(`Failed to load KPIs for project ${projectId}:`, error);
    return {
      lastBackup: null,
      lastRestore: null,
      lastMock: null,
      totalRuns7d: 0,
      successRate7d: null,
      prevTotalRuns7d: 0,
      dailyRuns: new Array(7).fill(0),
    };
  }
}
