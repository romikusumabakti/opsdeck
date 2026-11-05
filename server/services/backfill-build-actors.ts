import {
  type BuildMissingActors,
  listBuildsMissingActors,
  listBuildsWithUnfilledRuns,
  listUnfilledAutoRunIds,
  setBuildActors,
  setRunsTriggeredBy,
} from "@/lib/deploy/repository";
import {
  type BuildActorsInput,
  buildActorsOrNulls,
} from "@/server/services/deploy-builds";

export type BackfillStore = {
  listBuildsMissingActors(): Promise<BuildMissingActors[]>;
  setBuildActors: typeof setBuildActors;
  listBuildsWithUnfilledRuns(): Promise<{ id: string; pushedBy: string }[]>;
  listUnfilledAutoRunIds(buildId: string): Promise<string[]>;
  setRunsTriggeredBy: typeof setRunsTriggeredBy;
};

export const dbStore: BackfillStore = {
  listBuildsMissingActors,
  setBuildActors,
  listBuildsWithUnfilledRuns,
  listUnfilledAutoRunIds,
  setRunsTriggeredBy,
};

export type BackfillCounts = {
  builds: number;
  buildsFilled: number;
  buildsSkipped: number;
  runsFilled: number;
};

/**
 * Fills who pushed existing builds from their pipelines, then the auto runs of
 * those builds. Sequential, each lookup capped like the live hook (best-effort:
 * a failure skips the build). Safe to rerun: only rows still without a value
 * are written. With `dryRun` nothing is written; the counts say what would be.
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
  };

  const fillRuns = async (buildId: string, pushedBy: string) => {
    const runIds = await store.listUnfilledAutoRunIds(buildId);
    if (!options.dryRun) await store.setRunsTriggeredBy(runIds, pushedBy);
    counts.runsFilled += runIds.length;
  };

  for (const build of await store.listBuildsMissingActors()) {
    counts.builds++;
    const actors = await lookup({
      app: build.componentKey,
      tag: build.tag,
      pipelineUrl: build.pipelineUrl,
    });
    if (!actors.pushedBy) {
      counts.buildsSkipped++;
      continue;
    }
    if (!options.dryRun) await store.setBuildActors(build.id, actors);
    counts.buildsFilled++;
    await fillRuns(build.id, actors.pushedBy);
  }

  // Builds filled earlier whose runs were not (an interrupted run, or runs
  // created after the build was filled).
  for (const build of await store.listBuildsWithUnfilledRuns()) {
    await fillRuns(build.id, build.pushedBy);
  }
  return counts;
}
