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

type B = {
  id: string;
  pushedBy: string | null;
  commitAuthorEmail: string | null;
  commitMessage: string | null;
};
type Actors = Omit<B, "id">;

const actorOf = (b: B) =>
  b.pushedBy ?? b.commitAuthorEmail?.trim().toLowerCase() ?? null;

function fakeStore() {
  const none = { commitAuthorEmail: null, commitMessage: null };
  const builds: B[] = [
    { id: "b1", pushedBy: null, ...none },
    { id: "b2", pushedBy: null, ...none },
    { id: "b3", pushedBy: "carol", ...none },
    { id: "b4", pushedBy: null, ...none },
    // Already known by its commit email (filled by the live hook).
    {
      id: "b5",
      pushedBy: null,
      commitAuthorEmail: "e@x.test",
      commitMessage: "m",
    },
  ];
  const runs = [
    { id: "r1", buildId: "b1", triggeredBy: null as string | null },
    { id: "r2", buildId: "b1", triggeredBy: null as string | null },
    { id: "r3", buildId: "b3", triggeredBy: null as string | null },
    { id: "r4", buildId: "b4", triggeredBy: null as string | null },
    { id: "r5", buildId: "b5", triggeredBy: null as string | null },
  ];
  const find = (id: string) => builds.find((b) => b.id === id) as B;
  return {
    builds,
    runs,
    store: {
      listBuildsMissingActors: async () =>
        builds
          .filter((b) => !b.pushedBy && !b.commitAuthorEmail)
          .map((b) => ({
            id: b.id,
            componentKey: "c",
            tag: `t-${b.id}`,
            pipelineUrl: `https://ci.test/repos/1/pipeline/${b.id.slice(1)}`,
          })),
      // Null-only per column, like the real query.
      setBuildActors: vi.fn(async (id: string, a: Actors) => {
        const b = find(id);
        b.pushedBy ??= a.pushedBy;
        b.commitAuthorEmail ??= a.commitAuthorEmail;
        b.commitMessage ??= a.commitMessage;
      }),
      listBuildsWithUnfilledRuns: async () =>
        builds.flatMap((b) => {
          const actor = actorOf(b);
          return actor && runs.some((r) => r.buildId === b.id && !r.triggeredBy)
            ? [{ id: b.id, actor }]
            : [];
        }),
      listUnfilledAutoRunIds: async (id: string) =>
        runs.filter((r) => r.buildId === id && !r.triggeredBy).map((r) => r.id),
      setRunsTriggeredBy: vi.fn(async (ids: string[], by: string) => {
        for (const r of runs) if (ids.includes(r.id)) r.triggeredBy = by;
      }),
    },
  };
}

// b1 resolves to alice; b2 only to a commit email (Bitbucket sends no login);
// b4 fails (an outage: all-null actors).
const lookup = vi.fn(async (b: { tag: string }) => {
  if (b.tag === "t-b1") {
    return {
      pushedBy: "alice",
      commitAuthorEmail: "a@x.test",
      commitMessage: "m",
    };
  }
  if (b.tag === "t-b2") {
    return {
      pushedBy: null,
      commitAuthorEmail: " Bob@X.test",
      commitMessage: "fix",
    };
  }
  return { pushedBy: null, commitAuthorEmail: null, commitMessage: null };
});

describe("backfillBuildActors", () => {
  it("writes nothing on a dry run but counts what it would do", async () => {
    const f = fakeStore();
    const counts = await backfillBuildActors(
      { dryRun: true },
      { store: f.store, lookup }
    );
    expect(counts).toEqual({
      builds: 3,
      buildsFilled: 2,
      buildsSkipped: 1,
      runsFilled: 4,
    });
    expect(f.store.setBuildActors).not.toHaveBeenCalled();
    expect(f.store.setRunsTriggeredBy).not.toHaveBeenCalled();
    expect(f.builds.map((b) => b.pushedBy)).toEqual([
      null,
      null,
      "carol",
      null,
      null,
    ]);
    expect(f.runs.every((r) => r.triggeredBy === null)).toBe(true);
  });

  it("fills builds and their auto runs, then does nothing on a second run", async () => {
    const f = fakeStore();
    const first = await backfillBuildActors(
      { dryRun: false },
      { store: f.store, lookup }
    );
    expect(first).toEqual({
      builds: 3,
      buildsFilled: 2,
      buildsSkipped: 1,
      runsFilled: 4,
    });
    expect(f.runs.map((r) => r.triggeredBy)).toEqual([
      "alice",
      "alice",
      "carol",
      null,
      "e@x.test",
    ]);
    // An email-only lookup is a success: its columns are stored as given.
    expect(f.builds[1]).toMatchObject({
      pushedBy: null,
      commitAuthorEmail: " Bob@X.test",
      commitMessage: "fix",
    });
    expect(f.builds[3]?.commitAuthorEmail).toBeNull();

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
  });

  it("gives the runs of an email-only build the normalised email", async () => {
    const f = fakeStore();
    f.runs.push({ id: "r6", buildId: "b2", triggeredBy: null });
    await backfillBuildActors({ dryRun: false }, { store: f.store, lookup });
    expect(f.runs.find((r) => r.id === "r6")?.triggeredBy).toBe("bob@x.test");
  });
});
