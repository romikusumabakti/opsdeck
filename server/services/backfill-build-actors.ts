import {
  type BuildMissingActors,
  listBuildsMissingActors,
  listBuildsWithUnfilledRuns,
  listPreDeployBackupActors,
  listUnfilledAutoRunIds,
  type RunActorColumns,
  setBuildActors,
  setRunActor,
  setRunsTriggeredBy,
} from "@/lib/deploy/repository";
import { autoRunActor } from "@/lib/deploy/run-actor";
import {
  type BuildActorsInput,
  buildActorsOrNulls,
} from "@/server/services/deploy-builds";

export type BackfillStore = {
  listBuildsMissingActors(): Promise<BuildMissingActors[]>;
  setBuildActors: typeof setBuildActors;
  listBuildsWithUnfilledRuns(): Promise<{ id: string; actor: string }[]>;
  listUnfilledAutoRunIds(buildId: string): Promise<string[]>;
  setRunsTriggeredBy: typeof setRunsTriggeredBy;
  listPreDeployBackupActors(): Promise<({ runId: string } & RunActorColumns)[]>;
  setRunActor: typeof setRunActor;
};

export const dbStore: BackfillStore = {
  listBuildsMissingActors,
  setBuildActors,
  listBuildsWithUnfilledRuns,
  listUnfilledAutoRunIds,
  setRunsTriggeredBy,
  listPreDeployBackupActors,
  setRunActor,
};

export type BackfillCounts = {
  builds: number;
  buildsFilled: number;
  buildsSkipped: number;
  runsFilled: number;
  /** Pre-deploy backup runs without an actor. */
  backupRuns: number;
  /** Of those, the ones given their deploy run's actor. */
  backupRunsFilled: number;
};

/**
 * Fills who pushed existing builds (or, when the forge sends no login, their
 * commit author email) from their pipelines, then the auto runs of those
 * builds. Sequential, each lookup capped like the live hook (best-effort: a
 * failure skips the build). Last, pre-deploy backup runs get the actor of
 * their deploy run (filled by then). Safe to rerun: only columns (or, for the
 * backup runs, runs) still without a value are written. With `dryRun` nothing
 * is written; the counts say what would be.
 */
export async function backfillBuildActors(
  options: { dryRun: boolean },
  deps: {
    store?: BackfillStore;
    lookup?: (b: BuildActorsInput) => ReturnType<typeof buildActorsOrNulls>;
  } = {}
): Promise<BackfillCounts> {
  const store = deps.store ?? dbStore;
  const lookup = deps.lookup ?? buildActorsOrNulls;
  const counts: BackfillCounts = {
    builds: 0,
    buildsFilled: 0,
    buildsSkipped: 0,
    runsFilled: 0,
    backupRuns: 0,
    backupRunsFilled: 0,
  };

  const fillRuns = async (buildId: string, actor: string) => {
    const runIds = await store.listUnfilledAutoRunIds(buildId);
    if (!options.dryRun) await store.setRunsTriggeredBy(runIds, actor);
    counts.runsFilled += runIds.length;
  };

  for (const build of await store.listBuildsMissingActors()) {
    counts.builds++;
    const actors = await lookup({
      app: build.componentKey,
      tag: build.tag,
      pipelineUrl: build.pipelineUrl,
    });
    const actor = autoRunActor(actors);
    if (!actor) {
      counts.buildsSkipped++;
      continue;
    }
    if (!options.dryRun) await store.setBuildActors(build.id, actors);
    counts.buildsFilled++;
    await fillRuns(build.id, actor);
  }

  // Builds filled earlier whose runs were not (an interrupted run, or runs
  // created after the build was filled).
  for (const build of await store.listBuildsWithUnfilledRuns()) {
    await fillRuns(build.id, build.actor);
  }

  // After the runs above: a backup copies its deploy run's actor as it is now.
  for (const backup of await store.listPreDeployBackupActors()) {
    counts.backupRuns++;
    const { runId, userId, triggeredBy } = backup;
    if (!userId && !triggeredBy) continue;
    if (!options.dryRun)
      await store.setRunActor(runId, { userId, triggeredBy });
    counts.backupRunsFilled++;
  }
  return counts;
}
