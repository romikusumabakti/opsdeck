import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import {
  activityLog,
  databaseHosts,
  deployTargets,
  type EnvironmentArchive,
  type EnvironmentArchiveFile,
  environmentArchives,
  environmentDeployLocks,
  environmentDomains,
  environmentServices,
  environments,
  environmentVariables,
  projects,
  type Run,
  runs,
  servers,
  type TeardownStep,
  teardownSteps,
} from "@/lib/db/schema";
import { replaceSteps } from "@/lib/steps/replace-steps";
import { holdEnvironmentExclusive } from "@/lib/teardown/guard";
import { normaliseHost } from "@/lib/teardown/paths";
import type { TeardownStepSpec } from "@/lib/teardown/plan";
import { ENV_ARCHIVE_RETENTION_DAYS } from "@/lib/teardown/retention";

/** What planTeardown needs of an environment. Dirs and hosts as stored. */
export type TeardownEnvironment = {
  /** The environment's deploy targets with their server's host. */
  targets: { serverId: string; host: string; deployDir: string }[];
  /** Every other environment's target with its server's host. */
  otherTargets: { host: string; deployDir: string }[];
  dbServices: {
    id: string;
    dbType: "postgres" | "mssql" | "mysql" | null;
    dbKind: "shared" | "container" | "external" | null;
  }[];
  /** Row ids (cloudflare_zones, remote_tunnels) and Cloudflare object ids. */
  domain: {
    kind: "tunnel" | "external";
    hostname: string;
    zoneId: string | null;
    remoteTunnelId: string | null;
    accessAppId: string | null;
    dnsRecordId: string | null;
  } | null;
  /** Other environments' domains that record the same Access app or DNS record. */
  otherDomains: { accessAppId: string | null; dnsRecordId: string | null }[];
};

/** The environment's targets, db services and domain, or null when absent. */
export async function loadTeardownEnvironment(
  environmentId: string
): Promise<TeardownEnvironment | null> {
  const [env] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!env) return null;

  const targets = await db
    .select({
      serverId: deployTargets.serverId,
      host: servers.host,
      deployDir: deployTargets.deployDir,
    })
    .from(deployTargets)
    .innerJoin(servers, eq(servers.id, deployTargets.serverId))
    .where(eq(deployTargets.environmentId, environmentId))
    .orderBy(asc(deployTargets.createdAt), asc(deployTargets.id));
  // Every other environment's target with its host: planTeardown matches
  // machines by normalised host, since two server rows (another login, say)
  // can be one machine. The Panel has tens of targets, not thousands.
  const otherTargets =
    targets.length === 0
      ? []
      : await db
          .select({ host: servers.host, deployDir: deployTargets.deployDir })
          .from(deployTargets)
          .innerJoin(servers, eq(servers.id, deployTargets.serverId))
          .where(ne(deployTargets.environmentId, environmentId))
          .orderBy(asc(deployTargets.id));

  const dbServices = await db
    .select({
      id: environmentServices.id,
      dbType: environmentServices.dbType,
      dbKind: environmentServices.dbKind,
    })
    .from(environmentServices)
    .where(
      and(
        eq(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db")
      )
    )
    .orderBy(asc(environmentServices.id));

  const [domain] = await db
    .select({
      kind: environmentDomains.kind,
      hostname: environmentDomains.hostname,
      zoneId: environmentDomains.zoneId,
      remoteTunnelId: environmentDomains.remoteTunnelId,
      accessAppId: environmentDomains.accessAppId,
      dnsRecordId: environmentDomains.dnsRecordId,
    })
    .from(environmentDomains)
    .where(eq(environmentDomains.environmentId, environmentId));

  const ids = [domain?.accessAppId, domain?.dnsRecordId].filter(
    (id): id is string => typeof id === "string"
  );
  const otherDomains =
    ids.length === 0
      ? []
      : await db
          .select({
            accessAppId: environmentDomains.accessAppId,
            dnsRecordId: environmentDomains.dnsRecordId,
          })
          .from(environmentDomains)
          .where(
            and(
              ne(environmentDomains.environmentId, environmentId),
              or(
                inArray(environmentDomains.accessAppId, ids),
                inArray(environmentDomains.dnsRecordId, ids)
              )
            )
          )
          .orderBy(asc(environmentDomains.environmentId));

  return {
    targets,
    otherTargets,
    dbServices,
    domain: domain ?? null,
    otherDomains,
  };
}

export async function listTeardownSteps(
  environmentId: string
): Promise<TeardownStep[]> {
  return db
    .select()
    .from(teardownSteps)
    .where(eq(teardownSteps.environmentId, environmentId))
    .orderBy(asc(teardownSteps.position));
}

/**
 * Replaces the environment's teardown steps. A `done` step whose kind and
 * params equal a spec is kept (moved to the spec's position), so planning
 * again after a partial teardown never redoes finished work; every other
 * step is dropped and re-created `pending`.
 */
export async function saveTeardownSteps(
  environmentId: string,
  specs: TeardownStepSpec[]
): Promise<void> {
  await replaceSteps(teardownSteps, environmentId, specs);
}

/** What the server steps re-check at run time on one machine. */
export type StackGuard = {
  /** Other environments' deploy dirs on the machine, as stored. */
  otherDeployDirs: string[];
  /**
   * Containers a stack of this environment must never take down: every
   * registered database host's container on the machine, and every other
   * environment's docker db service there.
   */
  databaseContainers: string[];
};

/**
 * The current rows a server step checks against (another environment may
 * have been created since the plan), for the machine behind `serverId`:
 * matched by normalised host, as planTeardown does. Null when the server row
 * is gone.
 */
export async function loadStackGuard(
  environmentId: string,
  serverId: string
): Promise<StackGuard | null> {
  const all = await db
    .select({ id: servers.id, host: servers.host })
    .from(servers);
  const ours = all.find((server) => server.id === serverId);
  if (!ours) return null;
  const host = normaliseHost(ours.host);
  const machine = all
    .filter((server) => normaliseHost(server.host) === host)
    .map((server) => server.id);

  const otherTargets = await db
    .select({ deployDir: deployTargets.deployDir })
    .from(deployTargets)
    .where(
      and(
        inArray(deployTargets.serverId, machine),
        ne(deployTargets.environmentId, environmentId)
      )
    )
    .orderBy(asc(deployTargets.id));
  const hosts = await db
    .select({ containerName: databaseHosts.containerName })
    .from(databaseHosts)
    .where(inArray(databaseHosts.serverId, machine))
    .orderBy(asc(databaseHosts.id));
  const otherDbServices = await db
    .select({ serviceName: environmentServices.serviceName })
    .from(environmentServices)
    .where(
      and(
        inArray(environmentServices.serverId, machine),
        ne(environmentServices.environmentId, environmentId),
        eq(environmentServices.role, "db"),
        eq(environmentServices.serviceType, "docker")
      )
    )
    .orderBy(asc(environmentServices.id));
  return {
    otherDeployDirs: otherTargets.map((t) => t.deployDir),
    databaseContainers: [
      ...new Set([
        ...hosts.map((h) => h.containerName),
        ...otherDbServices.map((s) => s.serviceName),
      ]),
    ],
  };
}

/**
 * The db binding an archive_database or drop_database step names, or null
 * when it is gone.
 */
export async function loadTeardownDbService(serviceId: string) {
  const [row] = await db
    .select({
      environmentId: environmentServices.environmentId,
      role: environmentServices.role,
      dbType: environmentServices.dbType,
      dbKind: environmentServices.dbKind,
      dbName: environmentServices.dbName,
      dbRole: environmentServices.dbRole,
      databaseHostId: environmentServices.databaseHostId,
      serverId: environmentServices.serverId,
      serviceType: environmentServices.serviceType,
      serviceName: environmentServices.serviceName,
    })
    .from(environmentServices)
    .where(eq(environmentServices.id, serviceId));
  return row ?? null;
}

// --- The runner's rows ---

export async function getTeardownRun(runId: string): Promise<{
  environmentId: string;
  userId: string | null;
  status: Run["status"];
} | null> {
  const [row] = await db
    .select({
      environmentId: runs.environmentId,
      userId: runs.userId,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  return row ?? null;
}

/** `error` is the stable code of a failure (TEARDOWN_ERRORS). */
export async function markTeardownStep(
  id: string,
  status: TeardownStep["status"],
  { error, runId }: { error?: string; runId: string }
): Promise<void> {
  await db
    .update(teardownSteps)
    .set({
      status,
      lastError: status === "failed" ? (error ?? null) : null,
      lastRunId: runId,
      completedAt: status === "done" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(teardownSteps.id, id));
}

/** Marks the environment's `running` steps failed with `code`. */
export async function failRunningTeardownSteps(
  environmentId: string,
  code: string
): Promise<void> {
  await db
    .update(teardownSteps)
    .set({ status: "failed", lastError: code, updatedAt: new Date() })
    .where(
      and(
        eq(teardownSteps.environmentId, environmentId),
        eq(teardownSteps.status, "running")
      )
    );
}

// --- Archives ---

/** The names an archive row keeps of a deleted environment. */
export async function loadArchiveSnapshot(environmentId: string): Promise<{
  projectName: string;
  environmentName: string;
  environmentSlug: string;
} | null> {
  const [row] = await db
    .select({
      projectName: projects.name,
      environmentName: environments.name,
      environmentSlug: environments.slug,
    })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(environments.id, environmentId));
  return row ?? null;
}

/**
 * The environment's archive still being written: one per teardown, found by
 * the environment and an unset completed_at, so a retry adds to it.
 */
export async function findOpenArchive(
  environmentId: string
): Promise<EnvironmentArchive | null> {
  const [row] = await db
    .select()
    .from(environmentArchives)
    .where(
      and(
        eq(environmentArchives.environmentId, environmentId),
        isNull(environmentArchives.completedAt)
      )
    )
    .orderBy(asc(environmentArchives.createdAt), asc(environmentArchives.id))
    .limit(1);
  return row ?? null;
}

/**
 * Inserts the environment's open archive, or returns the one already open:
 * the partial unique index allows one per environment, so two first archive
 * steps at once (a redelivered job still alive) share a row.
 */
export async function createArchive(
  values: typeof environmentArchives.$inferInsert
): Promise<EnvironmentArchive> {
  const [created] = await db
    .insert(environmentArchives)
    .values(values)
    .onConflictDoNothing({
      target: environmentArchives.environmentId,
      where: sql`${environmentArchives.completedAt} IS NULL`,
    })
    .returning();
  if (created) return created;
  const open = values.environmentId
    ? await findOpenArchive(values.environmentId)
    : null;
  if (!open) throw new Error("The open environment archive vanished");
  return open;
}

/** Appends a file to the archive's list, unless one of that name is listed. */
export async function addArchiveFile(
  archiveId: string,
  file: EnvironmentArchiveFile
): Promise<void> {
  const entry = JSON.stringify([file]);
  const named = JSON.stringify([{ name: file.name }]);
  await db
    .update(environmentArchives)
    .set({
      files: sql`case when ${environmentArchives.files} @> ${named}::jsonb then ${environmentArchives.files} else ${environmentArchives.files} || ${entry}::jsonb end`,
    })
    .where(eq(environmentArchives.id, archiveId));
}

const DAY_MS = 86_400_000;

/**
 * delete_environment: in one transaction, deletes the environment row (the
 * cascade removes its steps and runs), closes its open archive
 * (completed_at, and expires_at ENV_ARCHIVE_RETENTION_DAYS from now) and
 * records `environment.deleted` {environment, archiveId}, so a crash can
 * lose none of them. The archive id is the one just closed, else the newest
 * one already closed.
 *
 * Unless `escrowConfirmed`, the DELETE itself requires that the environment
 * has no escrowed variable (as the row-only delete does), so one escrowed
 * since the start still stops it: `refusal`, and nothing is written. Null
 * when the environment is gone already.
 */
export async function deleteTeardownEnvironment(
  environmentId: string,
  actorId: string | null,
  { escrowConfirmed }: { escrowConfirmed: boolean }
): Promise<
  | { environmentName: string; archiveId: string | null }
  | { refusal: "environmentHasEscrowedVariables" }
  | null
> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(environments)
      .where(
        escrowConfirmed
          ? eq(environments.id, environmentId)
          : and(
              eq(environments.id, environmentId),
              notExists(
                tx
                  .select({ id: environmentVariables.id })
                  .from(environmentVariables)
                  .where(
                    and(
                      eq(environmentVariables.environmentId, environmentId),
                      eq(environmentVariables.escrow, true)
                    )
                  )
              )
            )
      )
      .returning({ name: environments.name });
    if (!deleted) {
      const [still] = await tx
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.id, environmentId));
      return still
        ? { refusal: "environmentHasEscrowedVariables" as const }
        : null;
    }
    const now = new Date();
    const [closed] = await tx
      .update(environmentArchives)
      .set({
        completedAt: now,
        expiresAt: new Date(
          now.getTime() + ENV_ARCHIVE_RETENTION_DAYS * DAY_MS
        ),
      })
      .where(
        and(
          eq(environmentArchives.environmentId, environmentId),
          isNull(environmentArchives.completedAt)
        )
      )
      .returning({ id: environmentArchives.id });
    const [latest] = closed
      ? [closed]
      : await tx
          .select({ id: environmentArchives.id })
          .from(environmentArchives)
          .where(eq(environmentArchives.environmentId, environmentId))
          .orderBy(
            desc(environmentArchives.createdAt),
            desc(environmentArchives.id)
          )
          .limit(1);
    const archiveId = latest?.id ?? null;
    await tx.insert(activityLog).values({
      actorId,
      action: "environment.deleted",
      entityType: "environment",
      entityId: environmentId,
      data: {
        environment: deleted.name,
        ...(archiveId ? { archiveId } : {}),
      },
    });
    return { environmentName: deleted.name, archiveId };
  });
}

export async function environmentExists(
  environmentId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return row !== undefined;
}

// --- The delete API's rows ---

/** What the delete API checks of an environment, or null when it is gone. */
export async function loadTeardownSubject(environmentId: string): Promise<{
  name: string;
  kind: (typeof environments.$inferSelect)["kind"];
  hasEscrowedVariables: boolean;
} | null> {
  const [row] = await db
    .select({
      name: environments.name,
      kind: environments.kind,
      hasEscrowedVariables: exists(
        db
          .select({ id: environmentVariables.id })
          .from(environmentVariables)
          .where(
            and(
              eq(environmentVariables.environmentId, environments.id),
              eq(environmentVariables.escrow, true)
            )
          )
      ).mapWith(Boolean),
    })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return row ?? null;
}

/** Run kinds that act on an environment's stack or data while they run. */
const BUSY_RUN_KINDS = ["deploy", "provision", "backup", "restore"] as const;

/**
 * Whether a teardown must wait: a deploy, provisioning, backup or restore run
 * is `started` on the environment, or its deploy lock is active.
 */
export async function environmentBusy(
  environmentId: string,
  executor: Pick<typeof db, "select"> = db
): Promise<boolean> {
  const [run] = await executor
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.environmentId, environmentId),
        eq(runs.status, "started"),
        inArray(runs.kind, [...BUSY_RUN_KINDS])
      )
    )
    .limit(1);
  if (run) return true;
  const [lock] = await executor
    .select({ id: environmentDeployLocks.environmentId })
    .from(environmentDeployLocks)
    .where(
      and(
        eq(environmentDeployLocks.environmentId, environmentId),
        gt(environmentDeployLocks.expiresAt, new Date())
      )
    )
    .limit(1);
  return lock !== undefined;
}

export type TeardownState = {
  /** The environment has teardown steps. */
  planned: boolean;
  /** A teardown run is `started`, or a step is `running`. */
  running: boolean;
  /** A step is `done`: the teardown is part way through. */
  progressed: boolean;
};

async function readTeardownState(
  executor: Pick<typeof db, "select">,
  environmentId: string
): Promise<TeardownState> {
  const steps = await executor
    .select({ status: teardownSteps.status })
    .from(teardownSteps)
    .where(eq(teardownSteps.environmentId, environmentId));
  const [run] = await executor
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.environmentId, environmentId),
        eq(runs.kind, "teardown"),
        eq(runs.status, "started")
      )
    )
    .limit(1);
  return {
    planned: steps.length > 0,
    running:
      run !== undefined || steps.some((step) => step.status === "running"),
    progressed: steps.some((step) => step.status === "done"),
  };
}

export async function teardownState(
  environmentId: string
): Promise<TeardownState> {
  return readTeardownState(db, environmentId);
}

/**
 * Opens the environment's `teardown` run, unless a teardown is running
 * (teardownRunning), or, for a fresh start, one already got somewhere (a
 * step is done: the client resumes it with a retry instead), or the
 * environment is busy (environmentBusy). The checks and the insert hold the
 * environment's advisory lock exclusively (the key provisioning and, shared,
 * deploys, backups and restores take: lib/teardown/guard), so two requests
 * cannot both pass, and no deploy or backup is placed in between.
 */
export async function startTeardownRun(
  environmentId: string,
  userId: string | null,
  mode: "start" | "retry"
): Promise<
  { runId: string } | { refusal: "teardownRunning" | "environmentBusy" }
> {
  return db.transaction(async (tx) => {
    await holdEnvironmentExclusive(tx, environmentId);
    const state = await readTeardownState(tx, environmentId);
    if (state.running || (mode === "start" && state.progressed)) {
      return { refusal: "teardownRunning" as const };
    }
    if (await environmentBusy(environmentId, tx)) {
      return { refusal: "environmentBusy" as const };
    }
    const run = one(
      await tx
        .insert(runs)
        .values({
          environmentId,
          userId,
          kind: "teardown",
          description: "Delete environment",
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

/** The steps a cancelled teardown may have finished: checks and archives. */
export const CANCELLABLE_DONE_KINDS: ReadonlySet<string> = new Set<
  TeardownStep["kind"]
>(["check_stack", "archive_database", "archive_deploy_dir", "archive_volumes"]);

/**
 * Cancels a teardown that has changed nothing yet: deletes its steps, which
 * lets deploys, backups and provisioning act on the environment again
 * (lib/teardown/guard). Only while no teardown run is started and no step
 * is running (teardownRunning), and only checks and archives are done
 * (teardownCannotCancel). The open archive is detached (environment_id
 * null) and left to the prune of incomplete archives, so the next teardown
 * archives afresh. Under the environment's advisory lock, exclusively,
 * so no run starts in between. `nothing` without steps.
 */
export async function cancelTeardownSteps(
  environmentId: string
): Promise<
  | { cancelled: true }
  | { nothing: true }
  | { refusal: "teardownRunning" | "teardownCannotCancel" }
> {
  return db.transaction(async (tx) => {
    await holdEnvironmentExclusive(tx, environmentId);
    const state = await readTeardownState(tx, environmentId);
    if (!state.planned) return { nothing: true as const };
    if (state.running) return { refusal: "teardownRunning" as const };
    const done = await tx
      .select({ kind: teardownSteps.kind })
      .from(teardownSteps)
      .where(
        and(
          eq(teardownSteps.environmentId, environmentId),
          eq(teardownSteps.status, "done")
        )
      );
    if (done.some((step) => !CANCELLABLE_DONE_KINDS.has(step.kind))) {
      return { refusal: "teardownCannotCancel" as const };
    }
    await tx
      .delete(teardownSteps)
      .where(eq(teardownSteps.environmentId, environmentId));
    // Detach the open archive: it stays open (completed_at null), so the
    // incomplete-archive prune removes it, and no later teardown can reuse
    // its files, which the environment has outdated by then.
    await tx
      .update(environmentArchives)
      .set({ environmentId: null })
      .where(
        and(
          eq(environmentArchives.environmentId, environmentId),
          isNull(environmentArchives.completedAt)
        )
      );
    return { cancelled: true as const };
  });
}

/** The environment's newest teardown run, or null. */
export async function latestTeardownRunId(
  environmentId: string
): Promise<string | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.environmentId, environmentId), eq(runs.kind, "teardown"))
    )
    .orderBy(desc(runs.runAt), desc(runs.id))
    .limit(1);
  return row?.id ?? null;
}

/** The message of a teardown run the worker restart closed. */
export const TEARDOWN_WORKER_RESTART_MESSAGE =
  "Worker restarted during the teardown; retry";

/**
 * Worker boot: there is a single worker, so a `teardown` run still `started`
 * has no live job behind it. Fails them, and marks their environments'
 * `running` steps failed (stepFailed), so a retry resumes there.
 */
export async function failStaleTeardownRuns(): Promise<number> {
  return db.transaction(async (tx) => {
    const failed = await tx
      .update(runs)
      .set({
        status: "failed",
        errorMessage: TEARDOWN_WORKER_RESTART_MESSAGE,
        completedAt: new Date(),
      })
      .where(and(eq(runs.kind, "teardown"), eq(runs.status, "started")))
      .returning({ environmentId: runs.environmentId });
    const envIds = [...new Set(failed.map((r) => r.environmentId))];
    if (envIds.length > 0) {
      await tx
        .update(teardownSteps)
        .set({
          status: "failed",
          lastError: "stepFailed",
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(teardownSteps.environmentId, envIds),
            eq(teardownSteps.status, "running")
          )
        );
    }
    return failed.length;
  });
}

// --- Archive listing and retention ---

/** Every environment archive, newest first. */
export async function listArchives(): Promise<EnvironmentArchive[]> {
  return db
    .select()
    .from(environmentArchives)
    .orderBy(desc(environmentArchives.createdAt), desc(environmentArchives.id));
}

export async function getArchive(
  id: string
): Promise<EnvironmentArchive | null> {
  const [row] = await db
    .select()
    .from(environmentArchives)
    .where(eq(environmentArchives.id, id));
  return row ?? null;
}

/**
 * The archives the daily prune deletes: completed ones past `expires_at`,
 * and open ones created before `incompleteBefore` whose environment has no
 * teardown steps left (the teardown was abandoned, the row removed from
 * the Panel, or the teardown cancelled: a detached archive's null
 * environment_id matches no step). An open archive whose teardown still has steps is kept even
 * past expiry: its finished archive steps are not taken again, so a retry
 * would go on to the destructive steps with the files gone.
 */
export async function listPrunableArchives(
  now: Date,
  incompleteBefore: Date
): Promise<EnvironmentArchive[]> {
  return db
    .select()
    .from(environmentArchives)
    .where(
      or(
        and(
          isNotNull(environmentArchives.completedAt),
          lt(environmentArchives.expiresAt, now)
        ),
        and(
          isNull(environmentArchives.completedAt),
          lt(environmentArchives.createdAt, incompleteBefore),
          notExists(
            db
              .select({ id: teardownSteps.id })
              .from(teardownSteps)
              .where(
                eq(
                  teardownSteps.environmentId,
                  environmentArchives.environmentId
                )
              )
          )
        )
      )
    )
    .orderBy(asc(environmentArchives.createdAt), asc(environmentArchives.id));
}

export async function deleteArchiveRow(id: string): Promise<void> {
  await db.delete(environmentArchives).where(eq(environmentArchives.id, id));
}
