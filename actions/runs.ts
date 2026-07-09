"use server";

import { and, desc, eq, gte, like } from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { type Run, runs } from "@/lib/db/schema";

export type RunWithUser = Run & {
  user: { id: string; name: string; email: string } | null;
};

export type ActiveRun = Pick<
  Run,
  "id" | "projectId" | "description" | "runAt"
> & {
  project: { id: string; name: string } | null;
};

// Returns currently-running runs across all projects, newest first. Used by
// the global header indicator so users can see and jump back into long
// background jobs (backup/restore/mock-time) even after dismissing the
// per-page dialog. Capped at 10 — more than that is a system-health issue,
// not a UX problem.
export type ProjectActivity = {
  status: Run["status"];
  runAt: Date;
};

/**
 * Returns a map of {projectId -> most recent run} so the projects list can
 * show an at-a-glance health dot per card. Uses Postgres `DISTINCT ON` —
 * cheaper than fetching the latest run per project in N round-trips.
 */
export async function getProjectsLastActivity(): Promise<
  Record<string, ProjectActivity>
> {
  await requireSession();
  try {
    const rows = await db
      .selectDistinctOn([runs.projectId], {
        projectId: runs.projectId,
        status: runs.status,
        runAt: runs.runAt,
      })
      .from(runs)
      .orderBy(runs.projectId, desc(runs.runAt));
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

export async function getActiveRuns(): Promise<ActiveRun[]> {
  await requireSession();
  try {
    const rows = await db.query.runs.findMany({
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
    return rows as ActiveRun[];
  } catch (error) {
    console.error("Failed to fetch running runs:", error);
    return [];
  }
}

export async function getProjectRuns(
  projectId: string
): Promise<RunWithUser[]> {
  await requireSession();
  try {
    const rows = await db.query.runs.findMany({
      where: { projectId },
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: { runAt: "desc" },
    });
    return rows as RunWithUser[];
  } catch (error) {
    console.error(`Failed to fetch runs for project ${projectId}:`, error);
    return [];
  }
}

export type RunSnapshot = Pick<
  Run,
  | "id"
  | "projectId"
  | "description"
  | "status"
  | "output"
  | "errorMessage"
  | "runAt"
  | "completedAt"
>;

export async function getRunSnapshot(
  runId: string
): Promise<RunSnapshot | null> {
  await requireSession();
  const row = await db.query.runs.findFirst({
    where: { id: runId },
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
  status: Run["status"];
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
    .select({ runAt: runs.runAt, status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        like(runs.description, `${KPI_PREFIX[kind]}%`)
      )
    )
    .orderBy(desc(runs.runAt))
    .limit(1);
  return row ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getProjectKpis(projectId: string): Promise<ProjectKpis> {
  await requireSession();
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
        .select({ status: runs.status, runAt: runs.runAt })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), gte(runs.runAt, since14))),
    ]);

    // Bucket by UTC day-index relative to today. Day 0 = today, day 6 = a
    // week ago, day 13 = two weeks ago. dailyRuns is reversed at the end so
    // the sparkline reads left-to-right (oldest -> newest).
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const dailyRuns = new Array(7).fill(0);
    let totalRuns7d = 0;
    let prevTotalRuns7d = 0;
    const completedCurrent: { status: Run["status"] }[] = [];

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
