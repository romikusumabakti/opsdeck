import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  deploymentDurationMs,
  deploysPollInterval,
  elapsedMs,
  headerState,
  logDeployment,
  releaseDeployment,
  rowActions,
  shortSha,
  type TimelineBuild,
  type TimelineDeployment,
  type TimelineInput,
  type TimelineRow,
} from "../web/routes/$locale/_app/-components/env/deploys/timeline-model";

const T0 = Date.parse("2026-11-10T00:00:00Z");
const at = (n: number) => new Date(T0 + n * 60_000).toISOString();

function build(tag: string, receivedAt: string, extra = {}): TimelineBuild {
  return {
    id: `b-${tag}`,
    tag,
    commitSha: `${tag}-sha`,
    commitMessage: `Message of ${tag}\nbody`,
    commitAuthorEmail: null,
    pipelineUrl: `https://ci.example.com/${tag}`,
    receivedAt,
    ...extra,
  } as unknown as TimelineBuild;
}

let seq = 0;
function deployment(
  tag: string,
  status: string,
  o: {
    id?: string;
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    runId?: string | null;
    build?: { branch: string; commitSha: string } | null;
  } = {}
): TimelineDeployment {
  seq += 1;
  const id = o.id ?? `d${String(seq).padStart(3, "0")}-${tag}-${status}`;
  return {
    id,
    tag,
    status,
    trigger: "manual",
    runId: o.runId === undefined ? `run-${id}` : o.runId,
    userName: null,
    triggeredBy: null,
    autoUser: null,
    build: o.build === undefined ? null : o.build,
    createdAt: o.createdAt ?? at(seq),
    startedAt:
      o.startedAt === undefined ? (o.createdAt ?? at(seq)) : o.startedAt,
    finishedAt: o.finishedAt === undefined ? null : o.finishedAt,
  } as unknown as TimelineDeployment;
}

function input(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    currentTag: null,
    currentStatus: null,
    previousTag: null,
    sourceBranch: "main",
    recentBuilds: [],
    recentDeployments: [],
    ...over,
  } as TimelineInput;
}

const row = (rows: TimelineRow[], tag: string) => {
  const r = rows.find((x) => x.tag === tag);
  if (!r) {
    throw new Error(`no row ${tag}`);
  }
  return r;
};

describe("buildTimeline", () => {
  it("merges builds and deployments into one row per tag", () => {
    const rows = buildTimeline(
      input({
        recentBuilds: [build("v3", at(30)), build("v2", at(20))],
        recentDeployments: [
          deployment("v2", "success", { id: "new", createdAt: at(25) }),
          deployment("v2", "failed", { id: "old", createdAt: at(21) }),
        ],
      })
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.deployments.map((d) => d.id)).toEqual(["new", "old"]);
    expect(rows[1]?.commitMessage).toBe("Message of v2");
  });

  it("deploy-only tags", () => {
    const rows = buildTimeline(
      input({
        recentDeployments: [
          deployment("v1", "success", {
            createdAt: at(10),
            build: { branch: "main", commitSha: "sha-v1" },
          }),
          deployment("v0", "success", {
            createdAt: at(5),
            build: { branch: "release", commitSha: "sha-v0" },
          }),
        ],
      })
    );
    expect(rows.map((r) => r.tag)).toEqual(["v1", "v0"]);
    expect(row(rows, "v1").deployable).toBe(true);
    expect(row(rows, "v0").deployable).toBe(false);
    expect(row(rows, "v0").commitSha).toBe("sha-v0");
    expect(row(rows, "v1").build).toBeNull();
    expect(row(rows, "v1").sortAt).toBe(at(10));
  });

  it("orders by build time, deploy-only tags by their latest deployment, synthetic rows last", () => {
    const rows = buildTimeline(
      input({
        previousTag: "v0",
        recentBuilds: [build("v1", at(1)), build("v3", at(3))],
        recentDeployments: [deployment("v9", "success", { createdAt: at(2) })],
      })
    );
    expect(rows.map((r) => r.tag)).toEqual(["v3", "v9", "v1", "v0"]);
    const last = rows[3];
    expect(last?.sortAt).toBeNull();
    expect(last?.status).toBe("previous");
  });

  it("ties on sortAt fall back to tag ascending", () => {
    const rows = buildTimeline(
      input({ recentBuilds: [build("b", at(1)), build("a", at(1))] })
    );
    expect(rows.map((r) => r.tag)).toEqual(["a", "b"]);
  });

  it("accepts Date values", () => {
    const rows = buildTimeline(
      input({
        recentBuilds: [build("v1", new Date(at(1)) as unknown as string)],
      })
    );
    expect(rows[0]?.receivedAt).toBe(at(1));
  });

  const statusCases: [string, TimelineInput, string, string | undefined][] = [
    [
      "live",
      input({
        currentTag: "v1",
        currentStatus: "success",
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "success", { id: "s", createdAt: at(2) }),
        ],
      }),
      "live",
      "s",
    ],
    [
      "previous",
      input({
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        recentBuilds: [build("v1", at(1)), build("v2", at(2))],
        recentDeployments: [
          deployment("v1", "success", { id: "s", createdAt: at(3) }),
        ],
      }),
      "previous",
      "s",
    ],
    [
      "lastGood",
      input({
        currentTag: "v2",
        currentStatus: "failed",
        previousTag: "v1",
        recentBuilds: [build("v1", at(1)), build("v2", at(2))],
        recentDeployments: [
          deployment("v1", "success", { id: "s", createdAt: at(3) }),
        ],
      }),
      "lastGood",
      "s",
    ],
    [
      "queued",
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "queued", { id: "q", createdAt: at(3) }),
          deployment("v1", "success", { id: "s", createdAt: at(2) }),
        ],
      }),
      "queued",
      "q",
    ],
    [
      "deploying",
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "queued", { id: "q", createdAt: at(4) }),
          deployment("v1", "running", { id: "r", createdAt: at(3) }),
        ],
      }),
      "deploying",
      "r",
    ],
    [
      "held",
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "held", { id: "h", createdAt: at(3) }),
          deployment("v1", "success", { id: "s", createdAt: at(2) }),
        ],
      }),
      "held",
      "h",
    ],
    [
      "failed",
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "failed", { id: "f", createdAt: at(3) }),
          deployment("v1", "success", { id: "s", createdAt: at(2) }),
        ],
      }),
      "failed",
      "f",
    ],
    [
      "deployedEarlier",
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "success", { id: "s", createdAt: at(2) }),
        ],
      }),
      "deployedEarlier",
      "s",
    ],
    [
      "skipped",
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "superseded", { id: "x", createdAt: at(2) }),
        ],
      }),
      "skipped",
      undefined,
    ],
    [
      "never",
      input({ recentBuilds: [build("v1", at(1))] }),
      "never",
      undefined,
    ],
  ];
  it.each(statusCases)("status %s", (_name, inp, status, subjectId) => {
    const r = row(buildTimeline(inp), "v1");
    expect(r.status).toBe(status);
    expect(r.subject?.id).toBe(subjectId);
  });

  it("running current without an active row is deploying with no subject", () => {
    const r = row(
      buildTimeline(
        input({
          currentTag: "v1",
          currentStatus: "running",
          recentBuilds: [build("v1", at(1))],
        })
      ),
      "v1"
    );
    expect(r.status).toBe("deploying");
    expect(r.subject).toBeNull();
  });

  it("failed current with a newer build", () => {
    const rows = buildTimeline(
      input({
        currentTag: "v2",
        currentStatus: "failed",
        previousTag: "v1",
        recentBuilds: [
          build("v3", at(3)),
          build("v2", at(2)),
          build("v1", at(1)),
        ],
        recentDeployments: [
          deployment("v2", "failed", { createdAt: at(5) }),
          deployment("v1", "success", { createdAt: at(4) }),
        ],
      })
    );
    expect(row(rows, "v2").status).toBe("failed");
    expect(row(rows, "v2").isLive).toBe(false);
    expect(row(rows, "v2").isCurrent).toBe(true);
    expect(row(rows, "v1").status).toBe("lastGood");
    expect(row(rows, "v3").status).toBe("never");
    expect(rows.some((r) => r.status === "live")).toBe(false);
  });

  it("superseded chains", () => {
    const rows = buildTimeline(
      input({
        recentBuilds: ["a", "b", "c", "d"].map((t, i) => build(t, at(i))),
        recentDeployments: [
          deployment("a", "superseded", { createdAt: at(10) }),
          deployment("a", "superseded", { createdAt: at(11) }),
          deployment("b", "success", { createdAt: at(10) }),
          deployment("b", "superseded", { createdAt: at(11) }),
          deployment("c", "failed", { createdAt: at(10) }),
          deployment("c", "superseded", { createdAt: at(11) }),
          deployment("d", "held", { createdAt: at(10) }),
        ],
      })
    );
    expect(row(rows, "a").status).toBe("skipped");
    expect(row(rows, "b").status).toBe("deployedEarlier");
    expect(row(rows, "c").status).toBe("failed");
    expect(row(rows, "d").status).toBe("held");
  });

  it("laterFailure: a failed redeploy after the subject's success, on rows that show no failure", () => {
    const rows = buildTimeline(
      input({
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        recentBuilds: [build("v2", at(20)), build("v1", at(10))],
        recentDeployments: [
          deployment("v2", "failed", { id: "v2-redo", createdAt: at(40) }),
          deployment("v2", "success", { createdAt: at(30) }),
          deployment("v1", "failed", { id: "v1-redo", createdAt: at(35) }),
          deployment("v1", "success", { createdAt: at(15) }),
        ],
      })
    );
    expect(row(rows, "v2").status).toBe("live");
    expect(row(rows, "v2").laterFailure?.id).toBe("v2-redo");
    expect(row(rows, "v1").status).toBe("previous");
    expect(row(rows, "v1").laterFailure?.id).toBe("v1-redo");
  });

  it("laterFailure is null when the newest settled deployment succeeded, or the row already reads Failed", () => {
    const rows = buildTimeline(
      input({
        currentTag: "v2",
        currentStatus: "failed",
        previousTag: "v1",
        recentDeployments: [
          deployment("v2", "failed", { createdAt: at(40) }),
          deployment("v1", "success", { createdAt: at(30) }),
          deployment("v1", "failed", { createdAt: at(20) }),
          deployment("v0", "failed", { createdAt: at(5) }),
        ],
      })
    );
    expect(row(rows, "v2").status).toBe("failed");
    expect(row(rows, "v2").laterFailure).toBeNull();
    expect(row(rows, "v1").laterFailure).toBeNull();
    expect(row(rows, "v0").status).toBe("failed");
    expect(row(rows, "v0").laterFailure).toBeNull();
  });

  it("durations", () => {
    const t = at(0);
    expect(
      deploymentDurationMs({ startedAt: t, finishedAt: at(1.5) } as never)
    ).toBe(90_000);
    expect(
      deploymentDurationMs({ startedAt: null, finishedAt: t } as never)
    ).toBeNull();
    expect(
      deploymentDurationMs({ startedAt: t, finishedAt: null } as never)
    ).toBeNull();
    expect(
      deploymentDurationMs({ startedAt: at(1), finishedAt: t } as never)
    ).toBe(0);
    const now = new Date(T0 + 5000);
    expect(elapsedMs({ startedAt: t } as never, now)).toBe(5000);
    expect(elapsedMs({ startedAt: null } as never, now)).toBeNull();
  });

  it("durationMs is the subject's", () => {
    const r = row(
      buildTimeline(
        input({
          recentBuilds: [build("v1", at(0))],
          recentDeployments: [
            deployment("v1", "success", {
              createdAt: at(1),
              startedAt: at(1),
              finishedAt: at(2),
            }),
          ],
        })
      ),
      "v1"
    );
    expect(r.durationMs).toBe(60_000);
  });
});

const failedCurrentInput = () =>
  input({
    currentTag: "v2",
    currentStatus: "failed",
    previousTag: "v1",
    recentBuilds: [build("v3", at(3)), build("v2", at(2)), build("v1", at(1))],
    recentDeployments: [
      deployment("v2", "failed", { id: "f2", createdAt: at(5) }),
      deployment("v1", "success", { id: "s1", createdAt: at(4) }),
    ],
  });

describe("headerState", () => {
  it("live focal line with who, when and the pipeline link", () => {
    const h = headerState(
      input({
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        recentBuilds: [build("v2", at(2)), build("v1", at(1))],
        recentDeployments: [
          deployment("v2", "success", { id: "new", createdAt: at(6) }),
          deployment("v2", "success", { id: "old", createdAt: at(4) }),
        ],
      })
    );
    expect(h.focal).toMatchObject({
      kind: "live",
      tag: "v2",
      commitSha: "v2-sha",
      pipelineUrl: "https://ci.example.com/v2",
    });
    expect(h.focal.kind === "live" && h.focal.deployment?.id).toBe("new");
    expect(h.rollbackTag).toBe("v1");
  });

  it("failed current: no live, last good, Deploy latest on the newer build", () => {
    const h = headerState(failedCurrentInput());
    expect(h.focal).toMatchObject({
      kind: "failedCurrent",
      tag: "v2",
      lastGood: "v1",
    });
    expect(h.failure).toBeNull();
    expect(h.deployLatest).toEqual({ tag: "v3", blocked: null });
    expect(h.rollbackTag).toBe("v1");
  });

  it("failed current is retried by Deploy latest when it is the newest build", () => {
    const h = headerState(
      input({
        currentTag: "v2",
        currentStatus: "failed",
        previousTag: "v1",
        recentBuilds: [build("v2", at(2)), build("v1", at(1))],
        recentDeployments: [
          deployment("v2", "failed", { createdAt: at(5) }),
          deployment("v1", "success", { createdAt: at(4) }),
        ],
      })
    );
    expect(h.deployLatest).toEqual({ tag: "v2", blocked: null });
  });

  it("live with a later failure before the script started shows one failure line", () => {
    const h = headerState(
      input({
        currentTag: "v1",
        currentStatus: "success",
        recentBuilds: [build("v2", at(2)), build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "success", { createdAt: at(3) }),
          deployment("v2", "failed", { createdAt: at(4) }),
        ],
      })
    );
    expect(h.focal.kind).toBe("live");
    expect(h.failure?.tag).toBe("v2");
  });

  it("a held or superseded deployment never makes a failure line", () => {
    const h = headerState(
      input({
        currentTag: "v1",
        currentStatus: "success",
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "success", { createdAt: at(3) }),
          deployment("v1", "held", { createdAt: at(4) }),
          deployment("v1", "superseded", { createdAt: at(5) }),
        ],
      })
    );
    expect(h.failure).toBeNull();
  });

  it("an older failure behind a newer success is not shown", () => {
    const h = headerState(
      input({
        currentTag: "v1",
        currentStatus: "success",
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "failed", { createdAt: at(2) }),
          deployment("v1", "success", { createdAt: at(3) }),
        ],
      })
    );
    expect(h.failure).toBeNull();
  });

  it("while deploying the focal line keeps the previous live tag", () => {
    const h = headerState(
      input({
        currentTag: "v2",
        currentStatus: "running",
        recentBuilds: [build("v2", at(2)), build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "success", { createdAt: at(3) }),
          deployment("v2", "running", { createdAt: at(4) }),
        ],
      })
    );
    expect(h.focal).toMatchObject({ kind: "live", tag: "v1" });
  });

  it("while deploying with no earlier success the focal line is never", () => {
    const h = headerState(
      input({
        currentTag: "v1",
        currentStatus: "running",
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [deployment("v1", "running", { createdAt: at(2) })],
      })
    );
    expect(h.focal).toEqual({ kind: "never" });
  });

  it("no state at all is never, without Deploy latest", () => {
    const h = headerState(input());
    expect(h.focal).toEqual({ kind: "never" });
    expect(h.deployLatest).toBeNull();
    expect(h.failure).toBeNull();
    expect(h.rollbackTag).toBeNull();
  });

  it("live focal falls back to the deployment's build when the tag has no build row", () => {
    const h = headerState(
      input({
        currentTag: "v1",
        currentStatus: "success",
        recentDeployments: [
          deployment("v1", "success", {
            build: { branch: "main", commitSha: "dep-sha" },
          }),
        ],
      })
    );
    expect(h.focal).toMatchObject({
      kind: "live",
      commitSha: "dep-sha",
      pipelineUrl: null,
    });
  });

  it.each([
    ["latestIsLive", "success", [] as string[]],
    ["deploying", "success", ["queued"]],
    ["held", "success", ["held"]],
  ])("Deploy latest is blocked: %s", (blocked, _s, extra) => {
    const live = blocked === "latestIsLive";
    const h = headerState(
      input({
        currentTag: live ? "v2" : "v1",
        currentStatus: "success",
        recentBuilds: [build("v2", at(2)), build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "success", { createdAt: at(3) }),
          ...(live
            ? [deployment("v2", "success", { createdAt: at(4) })]
            : extra.map((s) => deployment("v2", s, { createdAt: at(4) }))),
        ],
      })
    );
    expect(h.deployLatest).toEqual({ tag: "v2", blocked });
  });

  it("rollbackBusy while a rollback is queued or running, or the rollback tag deploys", () => {
    const base = {
      currentTag: "v2",
      currentStatus: "success" as const,
      previousTag: "v1",
      recentBuilds: [build("v2", at(2)), build("v1", at(1))],
    };
    const settled = [
      deployment("v2", "success", { createdAt: at(4) }),
      deployment("v1", "success", { createdAt: at(3) }),
    ];
    expect(
      headerState(input({ ...base, recentDeployments: settled })).rollbackBusy
    ).toBe(false);
    expect(
      headerState(
        input({
          ...base,
          recentDeployments: [
            deployment("v1", "queued", { createdAt: at(5) }),
            ...settled,
          ],
        })
      ).rollbackBusy
    ).toBe(true);
    // Running once its script started: the tags moved on, the rollback did not.
    const rollback = {
      ...deployment("v1", "running", { createdAt: at(5) }),
      trigger: "rollback",
    } as TimelineDeployment;
    expect(
      headerState(
        input({
          ...base,
          currentTag: "v1",
          currentStatus: "running",
          previousTag: "v2",
          recentDeployments: [rollback, ...settled],
        })
      ).rollbackBusy
    ).toBe(true);
    // A deploy of another tag does not block the rollback.
    expect(
      headerState(
        input({
          ...base,
          recentBuilds: [build("v3", at(5)), ...base.recentBuilds],
          recentDeployments: [
            deployment("v3", "running", { createdAt: at(6) }),
            ...settled,
          ],
        })
      ).rollbackBusy
    ).toBe(false);
  });

  it("running on the newest build is blocked as deploying", () => {
    const h = headerState(
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [deployment("v1", "running")],
      })
    );
    expect(h.deployLatest?.blocked).toBe("deploying");
  });
});

function plan(r: TimelineRow, ctx: Partial<Parameters<typeof rowActions>[1]>) {
  return rowActions(r, {
    canRun: true,
    canRollback: true,
    canRelease: true,
    releasableKind: true,
    rollbackBusy: false,
    ...ctx,
  });
}
const kinds = (p: ReturnType<typeof rowActions>) => p.map((a) => a.kind);

const actionInput = () =>
  input({
    currentTag: "v3",
    currentStatus: "success",
    previousTag: "v2",
    recentBuilds: [
      build("v4", at(4)),
      build("v3", at(3)),
      build("v2", at(2)),
      build("v1", at(1)),
    ],
    recentDeployments: [
      deployment("v3", "success", {
        createdAt: at(7),
        build: { branch: "main", commitSha: "x" },
      }),
      deployment("v2", "success", {
        createdAt: at(6),
        build: { branch: "main", commitSha: "x" },
      }),
      deployment("v1", "success", {
        createdAt: at(5),
        build: { branch: "main", commitSha: "x" },
      }),
    ],
  });

describe("rowActions", () => {
  it("live row: Redeploy, View log, View pipeline, Mark release; no rollback", () => {
    const r = row(buildTimeline(actionInput()), "v3");
    expect(kinds(plan(r, {}))).toEqual([
      "redeploy",
      "viewLog",
      "viewPipeline",
      "markRelease",
    ]);
  });

  it("failed current row offers Redeploy", () => {
    const r = row(buildTimeline(failedCurrentInput()), "v2");
    expect(kinds(plan(r, {}))).toContain("redeploy");
    expect(kinds(plan(r, {}))).not.toContain("rollback");
  });

  it("the last good row offers Roll back to this", () => {
    const r = row(buildTimeline(failedCurrentInput()), "v1");
    expect(r.status).toBe("lastGood");
    expect(kinds(plan(r, {}))).toContain("rollback");
  });

  it("current row without a build on the branch: Redeploy disabled with notBuilt", () => {
    const rows = buildTimeline(
      input({
        currentTag: "v0",
        currentStatus: "success",
        recentDeployments: [
          deployment("v0", "success", {
            build: { branch: "release", commitSha: "x" },
          }),
        ],
      })
    );
    const redeploy = plan(row(rows, "v0"), {}).find(
      (a) => a.kind === "redeploy"
    );
    expect(redeploy).toEqual({ kind: "redeploy", disabledReason: "notBuilt" });
  });

  it("previous row offers Roll back to this; an older success offers only Deploy this version", () => {
    const rows = buildTimeline(actionInput());
    expect(kinds(plan(row(rows, "v2"), {}))).toEqual([
      "deploy",
      "viewLog",
      "viewPipeline",
      "markRelease",
      "rollback",
    ]);
    const older = plan(row(rows, "v1"), {});
    expect(kinds(older)).toContain("deploy");
    expect(kinds(older)).not.toContain("rollback");
  });

  it("no Roll back to this while a rollback of the target is queued or running", () => {
    const rows = buildTimeline(actionInput());
    expect(kinds(plan(row(rows, "v2"), {}))).toContain("rollback");
    expect(kinds(plan(row(rows, "v2"), { rollbackBusy: true }))).not.toContain(
      "rollback"
    );
  });

  it("deploying and held rows offer no deploy and no rollback", () => {
    const rows = buildTimeline(
      input({
        previousTag: "v2",
        recentBuilds: [build("v2", at(2)), build("v1", at(1))],
        recentDeployments: [
          deployment("v2", "running", { createdAt: at(3) }),
          deployment("v1", "held", { createdAt: at(4), runId: null }),
        ],
      })
    );
    for (const tag of ["v1", "v2"]) {
      const k = kinds(plan(row(rows, tag), {}));
      expect(k).not.toContain("deploy");
      expect(k).not.toContain("redeploy");
      expect(k).not.toContain("rollback");
    }
  });

  it("held row has no View log", () => {
    const rows = buildTimeline(
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [deployment("v1", "held", { runId: null })],
      })
    );
    expect(kinds(plan(row(rows, "v1"), {}))).not.toContain("viewLog");
  });

  it("deploy-only row from another branch: deploy disabled with notBuilt", () => {
    const rows = buildTimeline(
      input({
        recentDeployments: [
          deployment("v0", "success", {
            build: { branch: "release", commitSha: "x" },
          }),
        ],
      })
    );
    const deploy = plan(row(rows, "v0"), {}).find((a) => a.kind === "deploy");
    expect(deploy).toEqual({ kind: "deploy", disabledReason: "notBuilt" });
  });

  it("Mark release needs a jar/static kind, the permission and a success with a known build", () => {
    const r = row(buildTimeline(actionInput()), "v3");
    expect(kinds(plan(r, { releasableKind: false }))).not.toContain(
      "markRelease"
    );
    expect(kinds(plan(r, { canRelease: false }))).not.toContain("markRelease");
    const noBuild = row(
      buildTimeline(
        input({
          recentDeployments: [deployment("v1", "success", { build: null })],
        })
      ),
      "v1"
    );
    expect(kinds(plan(noBuild, {}))).not.toContain("markRelease");
    expect(releaseDeployment(noBuild)).toBeNull();
    expect(releaseDeployment(r)?.status).toBe("success");
  });

  it("a viewer gets only View log and View pipeline", () => {
    const r = row(buildTimeline(actionInput()), "v2");
    expect(
      kinds(plan(r, { canRun: false, canRollback: false, canRelease: false }))
    ).toEqual(["viewLog", "viewPipeline"]);
  });

  it("logDeployment prefers the subject, else the newest with a run", () => {
    const rows = buildTimeline(
      input({
        recentBuilds: [build("v1", at(1))],
        recentDeployments: [
          deployment("v1", "held", { id: "h", createdAt: at(4), runId: null }),
          deployment("v1", "failed", { id: "f", createdAt: at(3) }),
        ],
      })
    );
    expect(logDeployment(row(rows, "v1"))?.id).toBe("f");
  });
});

describe("deploysPollInterval", () => {
  const target = (...statuses: string[]) => ({
    recentDeployments: statuses.map((s) => deployment("v1", s)),
  });
  it("5 s while queued or running", () => {
    expect(deploysPollInterval([target("success", "queued")])).toBe(5000);
    expect(deploysPollInterval([target("running")])).toBe(5000);
  });
  it("30 s while only held", () => {
    expect(deploysPollInterval([target("held", "success")])).toBe(30_000);
  });
  it("5 s when held and running coexist", () => {
    expect(deploysPollInterval([target("held"), target("running")])).toBe(5000);
  });
  it("off otherwise, and for undefined data", () => {
    expect(deploysPollInterval([target("success", "failed")])).toBe(false);
    expect(deploysPollInterval([])).toBe(false);
    expect(deploysPollInterval(undefined)).toBe(false);
  });
});

describe("shortSha", () => {
  it("keeps the first 7 characters, null when unknown", () => {
    expect(shortSha("abcdef0123456")).toBe("abcdef0");
    expect(shortSha(null)).toBeNull();
  });
});
