import { describe, expect, it, vi } from "vitest";

// The real store and lookup are replaced per call; keep the modules (and the
// database behind them) out of this test.
vi.mock("@/lib/deploy/repository", () => ({
  listBuildsMissingActors: vi.fn(),
  setBuildActors: vi.fn(),
  listBuildsWithUnfilledRuns: vi.fn(),
  listUnfilledAutoRunIds: vi.fn(),
  setRunsTriggeredBy: vi.fn(),
}));
vi.mock("@/server/services/deploy-builds", () => ({
  buildActorsOrNulls: vi.fn(),
}));

const { backfillBuildActors } = await import(
  "@/server/services/backfill-build-actors"
);

type B = { id: string; pushedBy: string | null };

function fakeStore() {
  const builds: B[] = [
    { id: "b1", pushedBy: null },
    { id: "b2", pushedBy: null },
    { id: "b3", pushedBy: "carol" },
  ];
  const runs = [
    { id: "r1", buildId: "b1", triggeredBy: null as string | null },
    { id: "r2", buildId: "b1", triggeredBy: null as string | null },
    { id: "r3", buildId: "b3", triggeredBy: null as string | null },
  ];
  const find = (id: string) => builds.find((b) => b.id === id) as B;
  return {
    builds,
    runs,
    store: {
      listBuildsMissingActors: async () =>
        builds
          .filter((b) => !b.pushedBy)
          .map((b) => ({
            id: b.id,
            componentKey: "c",
            tag: `t-${b.id}`,
            pipelineUrl: `https://ci.test/repos/1/pipeline/${b.id.slice(1)}`,
          })),
      setBuildActors: vi.fn(
        async (id: string, a: { pushedBy: string | null }) => {
          const b = find(id);
          if (!b.pushedBy) b.pushedBy = a.pushedBy;
        }
      ),
      listBuildsWithUnfilledRuns: async () =>
        builds.flatMap((b) =>
          b.pushedBy && runs.some((r) => r.buildId === b.id && !r.triggeredBy)
            ? [{ id: b.id, pushedBy: b.pushedBy }]
            : []
        ),
      listUnfilledAutoRunIds: async (id: string) =>
        runs.filter((r) => r.buildId === id && !r.triggeredBy).map((r) => r.id),
      setRunsTriggeredBy: vi.fn(async (ids: string[], by: string) => {
        for (const r of runs) if (ids.includes(r.id)) r.triggeredBy = by;
      }),
    },
  };
}

// b1 resolves to alice, b2 fails (an outage: all-null actors).
const lookup = vi.fn(async (b: { tag: string }) =>
  b.tag === "t-b1"
    ? { pushedBy: "alice", commitAuthorEmail: "a@x.test", commitMessage: "m" }
    : { pushedBy: null, commitAuthorEmail: null, commitMessage: null }
);

describe("backfillBuildActors", () => {
  it("writes nothing on a dry run but counts what it would do", async () => {
    const f = fakeStore();
    const counts = await backfillBuildActors(
      { dryRun: true },
      { store: f.store, lookup }
    );
    expect(counts).toEqual({
      builds: 2,
      buildsFilled: 1,
      buildsSkipped: 1,
      runsFilled: 3,
    });
    expect(f.store.setBuildActors).not.toHaveBeenCalled();
    expect(f.store.setRunsTriggeredBy).not.toHaveBeenCalled();
    expect(f.builds.map((b) => b.pushedBy)).toEqual([null, null, "carol"]);
    expect(f.runs.every((r) => r.triggeredBy === null)).toBe(true);
  });

  it("fills builds and their auto runs, then does nothing on a second run", async () => {
    const f = fakeStore();
    const first = await backfillBuildActors(
      { dryRun: false },
      { store: f.store, lookup }
    );
    expect(first).toEqual({
      builds: 2,
      buildsFilled: 1,
      buildsSkipped: 1,
      runsFilled: 3,
    });
    expect(f.runs.map((r) => r.triggeredBy)).toEqual([
      "alice",
      "alice",
      "carol",
    ]);
    expect(f.builds[1]?.pushedBy).toBeNull();

    const second = await backfillBuildActors(
      { dryRun: false },
      { store: f.store, lookup }
    );
    // Only the still-unknown build is retried; nothing new is written.
    expect(second).toEqual({
      builds: 1,
      buildsFilled: 0,
      buildsSkipped: 1,
      runsFilled: 0,
    });
    expect(f.store.setRunsTriggeredBy).toHaveBeenCalledTimes(2);
  });
});
