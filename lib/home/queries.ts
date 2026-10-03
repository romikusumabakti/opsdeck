import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import { getProjectAccess, projectScope } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  environmentAccess,
  environmentServices,
  environments,
  type IssueStatus,
  issues,
  projects,
  runs,
} from "@/lib/db/schema";
import {
  ATTENTION_WINDOW_DAYS,
  type FailureGroup,
  groupFailures,
} from "@/lib/home/attention";
import { canProject } from "@/lib/permissions";

// Read side of Home. Plain server functions (not actions): only the page's
// server components call them. Every one is scoped to the caller's projects and
// throws on DB failure so the page can render a per-card error instead of a
// misleading empty state.

// A run's grouping key, mirrored from attentionKey() in lib/home/attention.ts.
const runKey = sql<string>`coalesce(${runs.kind}::text, ${runs.description})`;

// Hard cap on failures scanned per render. 7 days of failures is normally a
// few dozen; this only bounds a pathological flood.
const FAILURE_SCAN_LIMIT = 500;

export type AttentionGroup = FailureGroup & { canAcknowledge: boolean };

export async function getAttentionGroups(): Promise<AttentionGroup[]> {
  await requireSession();
  const [scope, access] = await Promise.all([
    projectScope(environments.projectId),
    getProjectAccess(),
  ]);
  const since = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 86_400_000);

  const failed = await db
    .select({
      id: runs.id,
      environmentId: runs.environmentId,
      kind: runs.kind,
      description: runs.description,
      errorMessage: runs.errorMessage,
      runAt: runs.runAt,
      environmentName: environments.name,
      envSlug: environments.slug,
      projectId: environments.projectId,
      projectKey: projects.key,
    })
    .from(runs)
    .innerJoin(environments, eq(environments.id, runs.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(runs.status, "failed"),
        isNull(runs.acknowledgedAt),
        gte(runs.runAt, since),
        scope
      )
    )
    .orderBy(desc(runs.runAt))
    .limit(FAILURE_SCAN_LIMIT);
  if (failed.length === 0) return [];

  const envIds = [...new Set(failed.map((f) => f.environmentId))];
  // Latest success per (environment, key) since the window opened: anything
  // older can't be newer than a failure inside the window.
  const successes = await db
    .selectDistinctOn([runs.environmentId, runKey], {
      environmentId: runs.environmentId,
      key: runKey,
      runAt: runs.runAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.status, "success"),
        inArray(runs.environmentId, envIds),
        gte(runs.runAt, since)
      )
    )
    .orderBy(runs.environmentId, runKey, desc(runs.runAt));

  return groupFailures(
    failed.map((f) => ({
      ...f,
      envPath: `/${f.projectKey}/${f.envSlug}`,
    })),
    successes
  ).map((g) => ({
    ...g,
    canAcknowledge: canProject(access.roles[g.projectId] ?? null, {
      run: ["acknowledge"],
    }),
  }));
}

export type MyIssue = {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  projectKey: string;
  projectName: string;
};

export async function listMyOpenIssues(
  limit = 8
): Promise<{ items: MyIssue[]; total: number }> {
  const session = await requireSession();
  const where: SQL | undefined = and(
    eq(issues.assigneeId, session.user.id),
    inArray(issues.status, ["open", "in_progress"]),
    await projectScope(issues.projectId)
  );
  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        status: issues.status,
        projectKey: projects.key,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(where)
      // Work already in progress first, then most recently touched.
      .orderBy(
        sql`${issues.status} = 'in_progress' desc`,
        desc(issues.updatedAt)
      )
      .limit(limit),
    db.select({ total: count() }).from(issues).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export type RecentEnvironment = {
  id: string;
  name: string;
  path: string;
  projectId: string;
  projectName: string;
  hasDatabase: boolean;
  canBackup: boolean;
};

export async function listRecentEnvironments(
  limit = 5
): Promise<RecentEnvironment[]> {
  const session = await requireSession();
  const [scope, access] = await Promise.all([
    projectScope(environments.projectId),
    getProjectAccess(),
  ]);
  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
      slug: environments.slug,
      projectId: environments.projectId,
      projectKey: projects.key,
      projectName: projects.name,
      // EXISTS, not a join: only "has a db service" matters, and the service
      // row carries secret columns that must stay out of this projection.
      hasDatabase: sql<boolean>`exists (select 1 from ${environmentServices} where ${environmentServices.environmentId} = ${environments.id} and ${environmentServices.role} = 'db')`,
    })
    .from(environmentAccess)
    .innerJoin(
      environments,
      eq(environments.id, environmentAccess.environmentId)
    )
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(environmentAccess.userId, session.user.id), scope))
    .orderBy(desc(environmentAccess.lastAccessedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    path: `/${r.projectKey}/${r.slug}`,
    projectId: r.projectId,
    projectName: r.projectName,
    hasDatabase: r.hasDatabase,
    canBackup: canProject(access.roles[r.projectId] ?? null, {
      database: ["backup"],
    }),
  }));
}

export type IssueProject = { id: string; name: string; key: string };

/** Projects where the caller may create issues — the New-issue picker. */
export async function listIssueProjects(): Promise<IssueProject[]> {
  await requireSession();
  const access = await getProjectAccess();
  const ids = Object.entries(access.roles)
    .filter(([, role]) => canProject(role, { issue: ["write"] }))
    .map(([id]) => id);
  if (ids.length === 0) return [];
  return db
    .select({ id: projects.id, name: projects.name, key: projects.key })
    .from(projects)
    .where(inArray(projects.id, ids))
    .orderBy(asc(projects.name));
}

/** Does the caller operate any environment? Drives the attention section. */
export async function getHomeAccess(): Promise<{ hasOpsAccess: boolean }> {
  await requireSession();
  const access = await getProjectAccess();
  return {
    hasOpsAccess: Object.values(access.roles).some((role) =>
      canProject(role, { run: ["acknowledge"] })
    ),
  };
}
