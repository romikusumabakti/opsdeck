// Deploy targets for every demo environment, CI builds, and a month of
// finished deployments (each backed by a terminal `deploy` run, as the
// worker leaves them).
import { eq } from "drizzle-orm";
import {
  activityLog,
  builds,
  deployments,
  deployTargets,
  runs,
} from "@/lib/db/schema";
import { DEMO_PROJECTS } from "../seed-data/catalog";
import {
  planBuilds,
  planDeployments,
  plannedTargets,
} from "../seed-data/deploys";
import { addDays, addMinutes } from "../seed-data/random";
import { count, personId, type SeedContext } from "./context";

export async function seedDeploys(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  const infra = personId(ctx, "joko");
  // Targets created now, by `${projectKey}/${slug}/${componentKey}`. Only
  // these get a history: an existing target keeps the one it has.
  const fresh = new Map<string, { id: string; environmentId: string }>();
  const targets = plannedTargets();
  for (const [index, target] of targets.entries()) {
    const env = ctx.environments.get(`${target.project.key}/${target.slug}`);
    const appId = ctx.apps.get(target.project.app);
    const serverId = ctx.servers.get(target.project.defaultServer);
    // A target must deploy its environment's app; an environment that
    // predates the seed without one is left alone (assigning the app would
    // change it).
    if (!env || !appId || !serverId || env.appId !== appId) continue;
    const createdAt = addMinutes(addDays(ctx.now, -33), index * 3);
    const [row] = await tx
      .insert(deployTargets)
      .values({
        environmentId: env.id,
        componentKey: target.component.componentKey,
        serverId,
        sourceBranch: target.branch,
        autoDeploy: false,
        kind: "compose",
        deployDir: target.deployDir,
        services: [target.component.service],
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: deployTargets.id });
    if (!row) continue;
    count(ctx, "deployTargets");
    fresh.set(
      `${target.project.key}/${target.slug}/${target.component.componentKey}`,
      { id: row.id, environmentId: env.id }
    );
    // The entry creating a target writes (server/services/deploys auditTarget).
    await tx.insert(activityLog).values({
      actorId: infra,
      action: "deployTarget.created",
      entityType: "environment",
      entityId: env.id,
      data: { environment: env.name, component: target.component.componentKey },
      createdAt,
    });
    count(ctx, "activity");
  }

  const planned = planBuilds(ctx.now, ctx.emailDomain);
  if (planned.length === 0) return;
  const insertedBuilds = await tx
    .insert(builds)
    .values(planned)
    .onConflictDoNothing()
    .returning({ id: builds.id });
  count(ctx, "builds", insertedBuilds.length);
  const buildIds = new Map<string, string>();
  for (const componentKey of new Set(planned.map((b) => b.componentKey))) {
    const rows = await tx
      .select({ id: builds.id, tag: builds.tag })
      .from(builds)
      .where(eq(builds.componentKey, componentKey));
    for (const row of rows) buildIds.set(`${componentKey} ${row.tag}`, row.id);
  }

  if (fresh.size === 0) return;
  const hostOf = (key: string) =>
    DEMO_PROJECTS.find((p) => p.key === key)?.defaultServer ?? "";
  const history = planDeployments(
    ctx.now,
    planned,
    targets.filter((t) =>
      fresh.has(`${t.project.key}/${t.slug}/${t.component.componentKey}`)
    ),
    (project) => hostOf(project.key)
  );
  const runRows: (typeof runs.$inferInsert)[] = [];
  const deploymentRows: (typeof deployments.$inferInsert)[] = [];
  for (const d of history) {
    const target = fresh.get(`${d.projectKey}/${d.slug}/${d.componentKey}`);
    if (!target) continue;
    const actorId = personId(ctx, d.actor);
    const runId = Bun.randomUUIDv7();
    runRows.push({
      id: runId,
      environmentId: target.environmentId,
      userId: actorId,
      // Same text as lib/deploy/repository deploymentRunDescription.
      description: `Deploy ${d.componentKey} ${d.buildTag} (${d.trigger})`,
      status: d.status,
      kind: "deploy",
      output: d.output,
      errorMessage: d.errorMessage,
      runAt: d.createdAt,
      completedAt: d.finishedAt,
      acknowledgedAt: d.acknowledged ? addMinutes(d.finishedAt, 45) : null,
      acknowledgedById: d.acknowledged ? actorId : null,
    });
    deploymentRows.push({
      targetId: target.id,
      environmentId: target.environmentId,
      runId,
      tag: d.buildTag,
      trigger: d.trigger,
      status: d.status,
      buildId: buildIds.get(`${d.componentKey} ${d.buildTag}`) ?? null,
      createdAt: d.createdAt,
      startedAt: d.startedAt,
      heartbeatAt: d.finishedAt,
      scriptStartedAt: d.scriptStartedAt,
      finishedAt: d.finishedAt,
    });
  }
  // Every deployment row carries its run, so the two lists are the same
  // length; drizzle refuses an empty values().
  if (runRows.length === 0) return;
  await tx.insert(runs).values(runRows);
  await tx.insert(deployments).values(deploymentRows);
  count(ctx, "runs", runRows.length);
  count(ctx, "deployments", deploymentRows.length);
}
