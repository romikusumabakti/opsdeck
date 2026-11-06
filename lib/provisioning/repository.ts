import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  builds,
  databaseHosts,
  deployTargets,
  environmentServices,
  environments,
  type ProvisioningStep,
  provisioningSteps,
  runs,
  servers,
} from "@/lib/db/schema";
import {
  matchDoneSteps,
  type ProvisioningEnvironment,
  type ProvisioningStepSpec,
} from "@/lib/provisioning/plan";

/** The environment's name plus what planProvisioning needs, or null. */
export async function loadProvisioningConfig(
  environmentId: string
): Promise<({ name: string } & ProvisioningEnvironment) | null> {
  const [env] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!env) return null;
  const targets = await db
    .select({
      id: deployTargets.id,
      serverId: deployTargets.serverId,
      deployDir: deployTargets.deployDir,
      sourceBranch: deployTargets.sourceBranch,
    })
    .from(deployTargets)
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(asc(deployTargets.createdAt), asc(deployTargets.id));
  const [dbService] = await db
    .select({
      dbKind: environmentServices.dbKind,
      databaseHostId: environmentServices.databaseHostId,
      dbName: environmentServices.dbName,
      dbRole: environmentServices.dbRole,
      dbPasswordVariable: environmentServices.dbPasswordVariable,
    })
    .from(environmentServices)
    .where(
      and(
        eq(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db")
      )
    )
    .limit(1);
  return { name: env.name, targets, db: dbService ?? null };
}

export async function listSteps(
  environmentId: string
): Promise<ProvisioningStep[]> {
  return db
    .select()
    .from(provisioningSteps)
    .where(eq(provisioningSteps.environmentId, environmentId))
    .orderBy(asc(provisioningSteps.position));
}

/**
 * Replaces the environment's plan. Every non-`done` step is dropped and
 * re-created; a `done` step whose kind and params equal a spec is kept (moved
 * to the spec's position), so a re-plan after an edit keeps finished work.
 */
export async function savePlan(
  environmentId: string,
  specs: ProvisioningStepSpec[]
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(provisioningSteps)
      .where(eq(provisioningSteps.environmentId, environmentId));
    const keepIds = matchDoneSteps(existing, specs);
    const kept = new Set(keepIds.filter((id): id is string => id !== null));
    const dropIds = existing.filter((s) => !kept.has(s.id)).map((s) => s.id);
    if (dropIds.length > 0) {
      await tx
        .delete(provisioningSteps)
        .where(inArray(provisioningSteps.id, dropIds));
    }
    if (kept.size > 0) {
      // Two phases: park kept rows on negative positions so moving one never
      // collides with another's old position on the unique index.
      await tx
        .update(provisioningSteps)
        .set({ position: sql`-1 - ${provisioningSteps.position}` })
        .where(inArray(provisioningSteps.id, [...kept]));
    }
    for (const [position, spec] of specs.entries()) {
      const keepId = keepIds[position];
      if (keepId) {
        await tx
          .update(provisioningSteps)
          .set({ position })
          .where(eq(provisioningSteps.id, keepId));
      } else {
        await tx.insert(provisioningSteps).values({
          environmentId,
          position,
          kind: spec.kind,
          params: spec.params,
        });
      }
    }
  });
}

export async function getActiveProvisionRunId(
  environmentId: string
): Promise<string | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.environmentId, environmentId),
        eq(runs.kind, "provision"),
        eq(runs.status, "started")
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Creates the `provision` run, unless one of this environment is already
 * `started`. The check and the insert share a transaction-scoped advisory lock
 * on the environment id, so two concurrent requests cannot both pass.
 */
export async function startProvisioningRun(
  environmentId: string,
  userId: string
): Promise<{ runId: string } | { conflict: true }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${environmentId}::text, 0))`
    );
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.environmentId, environmentId),
          eq(runs.kind, "provision"),
          eq(runs.status, "started")
        )
      )
      .limit(1);
    if (active) return { conflict: true as const };
    const run = one(
      await tx
        .insert(runs)
        .values({
          environmentId,
          userId,
          kind: "provision",
          description: "Provision environment",
          runAt: new Date(),
          status: "started",
          output: "",
        })
        .returning({ id: runs.id }),
      "run"
    );
    return { runId: run.id };
  });
}

export async function markStep(
  id: string,
  status: ProvisioningStep["status"],
  { error, runId }: { error?: string; runId: string }
): Promise<void> {
  await db
    .update(provisioningSteps)
    .set({
      status,
      lastError: status === "failed" ? (error ?? null) : null,
      lastRunId: runId,
      completedAt: status === "done" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(provisioningSteps.id, id));
}

export async function getProvisionRun(
  runId: string
): Promise<{ environmentId: string; userId: string | null } | null> {
  const [row] = await db
    .select({ environmentId: runs.environmentId, userId: runs.userId })
    .from(runs)
    .where(eq(runs.id, runId));
  return row ?? null;
}

/** A database host with the SSH login of its server (password still encrypted). */
export async function loadDatabaseHost(id: string) {
  const [row] = await db
    .select({
      containerName: databaseHosts.containerName,
      server: servers,
    })
    .from(databaseHosts)
    .innerJoin(servers, eq(servers.id, databaseHosts.serverId))
    .where(eq(databaseHosts.id, id));
  return row ?? null;
}

export async function findNewestBuild(componentKey: string, branch: string) {
  const [row] = await db
    .select()
    .from(builds)
    .where(
      and(eq(builds.componentKey, componentKey), eq(builds.branch, branch))
    )
    .orderBy(desc(builds.receivedAt))
    .limit(1);
  return row ?? null;
}
