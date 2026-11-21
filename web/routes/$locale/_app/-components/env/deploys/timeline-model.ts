import { firstLine } from "@/lib/deploy/run-actor";
import type { DeployTargetState } from "@/web/api/deploys";

export type TimelineBuild = DeployTargetState["recentBuilds"][number];
export type TimelineDeployment = DeployTargetState["recentDeployments"][number];
export type DeploymentStatus = TimelineDeployment["status"];

export type TimelineInput = Pick<
  DeployTargetState,
  | "currentTag"
  | "currentStatus"
  | "previousTag"
  | "sourceBranch"
  | "recentBuilds"
  | "recentDeployments"
>;

export type RowStatusKind =
  | "live"
  | "previous"
  | "lastGood"
  | "queued"
  | "deploying"
  | "held"
  | "failed"
  | "skipped"
  | "deployedEarlier"
  | "never";

export type TimelineRow = {
  tag: string;
  build: TimelineBuild | null;
  commitSha: string | null;
  commitMessage: string | null;
  receivedAt: string | null;
  sortAt: string | null;
  /** This tag's deployments, newest `createdAt` first, then id descending. */
  deployments: TimelineDeployment[];
  status: RowStatusKind;
  /** The deployment the status describes. */
  subject: TimelineDeployment | null;
  /**
   * A failed deployment of this tag newer than its last success, on a row
   * whose status shows no failure (say a redeploy of the live tag that failed
   * before its script started), so the row still shows it.
   */
  laterFailure: TimelineDeployment | null;
  durationMs: number | null;
  isLive: boolean;
  isCurrent: boolean;
  isPrevious: boolean;
  deployable: boolean;
};

export const ACTIVE_POLL_MS = 5000;
export const HELD_POLL_MS = 30_000;

type Dated = string | Date | null | undefined;

const time = (x: Dated): number | null =>
  x === null || x === undefined ? null : new Date(x).getTime();

const iso = (x: Dated): string | null =>
  x === null || x === undefined ? null : new Date(x).toISOString();

function byNewest(a: TimelineDeployment, b: TimelineDeployment): number {
  return (
    (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0) ||
    b.id.localeCompare(a.id)
  );
}

const newestFirst = (list: TimelineDeployment[]) => [...list].sort(byNewest);

const newestWith = (list: TimelineDeployment[], status: DeploymentStatus) =>
  list.find((d) => d.status === status) ?? null;

export function deploymentDurationMs(
  d: Pick<TimelineDeployment, "startedAt" | "finishedAt">
): number | null {
  const start = time(d.startedAt);
  const end = time(d.finishedAt);
  if (start === null || end === null) {
    return null;
  }
  return Math.max(0, end - start);
}

export function elapsedMs(
  d: Pick<TimelineDeployment, "startedAt">,
  now: Date
): number | null {
  const start = time(d.startedAt);
  return start === null ? null : now.getTime() - start;
}

type Classified = Pick<TimelineRow, "status" | "subject">;

/** First match wins; the precedence is pinned by the model tests. */
function classify(
  deployments: TimelineDeployment[],
  flags: {
    isCurrent: boolean;
    isPrevious: boolean;
    currentStatus: TimelineInput["currentStatus"];
  }
): Classified {
  const running = newestWith(deployments, "running");
  if (running) {
    return { status: "deploying", subject: running };
  }
  const queued = newestWith(deployments, "queued");
  if (queued) {
    return { status: "queued", subject: queued };
  }
  if (deployments[0]?.status === "held") {
    return { status: "held", subject: deployments[0] };
  }
  const success = newestWith(deployments, "success");
  if (flags.isCurrent) {
    if (flags.currentStatus === "success") {
      return { status: "live", subject: success };
    }
    if (flags.currentStatus === "failed") {
      return { status: "failed", subject: newestWith(deployments, "failed") };
    }
    if (flags.currentStatus === "running") {
      return { status: "deploying", subject: null };
    }
  }
  if (flags.isPrevious) {
    return {
      status: flags.currentStatus === "failed" ? "lastGood" : "previous",
      subject: success,
    };
  }
  const settled = deployments.find(
    (d) => d.status !== "superseded" && d.status !== "held"
  );
  if (settled?.status === "failed") {
    return { status: "failed", subject: settled };
  }
  if (success) {
    return { status: "deployedEarlier", subject: success };
  }
  if (deployments.length > 0) {
    return { status: "skipped", subject: null };
  }
  return { status: "never", subject: null };
}

// Statuses that describe a past success, which a newer failure would hide.
const SUCCESS_STATUSES: ReadonlySet<RowStatusKind> = new Set([
  "live",
  "previous",
  "lastGood",
  "deployedEarlier",
]);

function laterFailureOf(
  deployments: TimelineDeployment[],
  status: RowStatusKind
): TimelineDeployment | null {
  if (!SUCCESS_STATUSES.has(status)) {
    return null;
  }
  const settled = deployments.find(
    (d) => d.status === "success" || d.status === "failed"
  );
  return settled?.status === "failed" ? settled : null;
}

export function buildTimeline(input: TimelineInput): TimelineRow[] {
  const buildByTag = new Map(input.recentBuilds.map((b) => [b.tag, b]));
  const deploymentsByTag = new Map<string, TimelineDeployment[]>();
  for (const d of input.recentDeployments) {
    deploymentsByTag.set(d.tag, [...(deploymentsByTag.get(d.tag) ?? []), d]);
  }
  const tags = new Set<string>([
    ...buildByTag.keys(),
    ...deploymentsByTag.keys(),
  ]);
  for (const t of [input.currentTag, input.previousTag]) {
    if (t) {
      tags.add(t);
    }
  }

  const rows = [...tags].map((tag): TimelineRow => {
    const build = buildByTag.get(tag) ?? null;
    const deployments = newestFirst(deploymentsByTag.get(tag) ?? []);
    const isCurrent = tag === input.currentTag;
    const isPrevious = tag === input.previousTag;
    const { status, subject } = classify(deployments, {
      isCurrent,
      isPrevious,
      currentStatus: input.currentStatus,
    });
    return {
      tag,
      build,
      commitSha:
        build?.commitSha ??
        deployments.find((d) => d.build)?.build?.commitSha ??
        null,
      commitMessage: firstLine(build?.commitMessage ?? null),
      receivedAt: iso(build?.receivedAt),
      sortAt: iso(build?.receivedAt ?? deployments[0]?.createdAt),
      deployments,
      status,
      subject,
      laterFailure: laterFailureOf(deployments, status),
      durationMs: subject ? deploymentDurationMs(subject) : null,
      isLive: isCurrent && input.currentStatus === "success",
      isCurrent,
      isPrevious,
      // Mirrors deployTag's 404 rule: a build row, or a deployment whose
      // build is on the target's source branch.
      deployable:
        build !== null ||
        deployments.some((d) => d.build?.branch === input.sourceBranch),
    };
  });

  return rows.sort((a, b) => {
    if (a.sortAt === null || b.sortAt === null) {
      if (a.sortAt !== b.sortAt) {
        return a.sortAt === null ? 1 : -1;
      }
    } else if (a.sortAt !== b.sortAt) {
      return a.sortAt < b.sortAt ? 1 : -1;
    }
    return a.tag.localeCompare(b.tag);
  });
}

export type HeaderState = {
  focal:
    | {
        kind: "live";
        tag: string;
        deployment: TimelineDeployment | null;
        commitSha: string | null;
        pipelineUrl: string | null;
      }
    | {
        kind: "failedCurrent";
        tag: string;
        deployment: TimelineDeployment | null;
        lastGood: string | null;
      }
    | { kind: "never" };
  failure: { tag: string; deployment: TimelineDeployment } | null;
  deployLatest: {
    tag: string;
    blocked: "latestIsLive" | "deploying" | "held" | null;
  } | null;
  rollbackTag: string | null;
};

function liveFocal(
  tag: string,
  deployment: TimelineDeployment | null,
  input: TimelineInput
): HeaderState["focal"] {
  const build = input.recentBuilds.find((b) => b.tag === tag) ?? null;
  return {
    kind: "live",
    tag,
    deployment,
    commitSha: build?.commitSha ?? deployment?.build?.commitSha ?? null,
    pipelineUrl: build?.pipelineUrl ?? null,
  };
}

function focalOf(
  input: TimelineInput,
  all: TimelineDeployment[]
): HeaderState["focal"] {
  const { currentTag, currentStatus } = input;
  if (currentTag && currentStatus === "success") {
    const mine = all.filter((d) => d.tag === currentTag);
    return liveFocal(currentTag, newestWith(mine, "success"), input);
  }
  if (currentTag && currentStatus === "failed") {
    const mine = all.filter((d) => d.tag === currentTag);
    return {
      kind: "failedCurrent",
      tag: currentTag,
      deployment: newestWith(mine, "failed"),
      lastGood: input.previousTag,
    };
  }
  if (currentStatus === null) {
    return { kind: "never" };
  }
  // Deploying (or otherwise unsettled): keep the previous live info.
  const lastSuccess = newestWith(all, "success");
  return lastSuccess
    ? liveFocal(lastSuccess.tag, lastSuccess, input)
    : { kind: "never" };
}

export function headerState(input: TimelineInput): HeaderState {
  const all = newestFirst(input.recentDeployments);
  const focal = focalOf(input, all);

  const lastSettled = all.find(
    (d) => d.status === "success" || d.status === "failed"
  );
  const sameAsFocal =
    focal.kind === "failedCurrent" && focal.deployment?.id === lastSettled?.id;
  const failure =
    lastSettled?.status === "failed" && !sameAsFocal
      ? { tag: lastSettled.tag, deployment: lastSettled }
      : null;

  const latest = input.recentBuilds[0];
  let deployLatest: HeaderState["deployLatest"] = null;
  if (latest) {
    const latestRow = buildTimeline(input).find((r) => r.tag === latest.tag);
    let blocked: NonNullable<HeaderState["deployLatest"]>["blocked"] = null;
    if (latestRow?.isLive) {
      blocked = "latestIsLive";
    } else if (
      latestRow?.status === "queued" ||
      latestRow?.status === "deploying"
    ) {
      blocked = "deploying";
    } else if (latestRow?.status === "held") {
      blocked = "held";
    }
    deployLatest = { tag: latest.tag, blocked };
  }

  return { focal, failure, deployLatest, rollbackTag: input.previousTag };
}

export type RowActionKind =
  | "deploy"
  | "redeploy"
  | "rollback"
  | "markRelease"
  | "viewPipeline"
  | "viewLog";

export type RowActionPlan = {
  kind: RowActionKind;
  disabledReason?: "notBuilt";
};

/** The newest success whose build is known, the source of a release. */
export function releaseDeployment(row: TimelineRow): TimelineDeployment | null {
  return (
    row.deployments.find((d) => d.status === "success" && d.build !== null) ??
    null
  );
}

/** The subject when it has a run, else the newest deployment that has one. */
export function logDeployment(row: TimelineRow): TimelineDeployment | null {
  if (row.subject?.runId) {
    return row.subject;
  }
  return row.deployments.find((d) => d.runId) ?? null;
}

export function rowActions(
  row: TimelineRow,
  ctx: {
    canRun: boolean;
    canRollback: boolean;
    canRelease: boolean;
    releasableKind: boolean;
  }
): RowActionPlan[] {
  const busy =
    row.status === "queued" ||
    row.status === "deploying" ||
    row.status === "held";
  const plan: RowActionPlan[] = [];
  if (ctx.canRun && !busy) {
    const kind = row.isCurrent ? "redeploy" : "deploy";
    plan.push(row.deployable ? { kind } : { kind, disabledReason: "notBuilt" });
  }
  if (logDeployment(row)) {
    plan.push({ kind: "viewLog" });
  }
  if (row.build?.pipelineUrl) {
    plan.push({ kind: "viewPipeline" });
  }
  if (ctx.canRelease && ctx.releasableKind && releaseDeployment(row)) {
    plan.push({ kind: "markRelease" });
  }
  if (ctx.canRollback && row.isPrevious && !busy) {
    plan.push({ kind: "rollback" });
  }
  return plan;
}

export function deploysPollInterval(
  targets: Pick<DeployTargetState, "recentDeployments">[] | undefined
): number | false {
  const statuses = (targets ?? []).flatMap((t) =>
    t.recentDeployments.map((d) => d.status)
  );
  if (statuses.some((s) => s === "queued" || s === "running")) {
    return ACTIVE_POLL_MS;
  }
  return statuses.includes("held") ? HELD_POLL_MS : false;
}
