import {
  CircleAlert,
  ExternalLink,
  Loader2,
  Lock,
  Rocket,
  ScrollText,
  Undo2,
} from "lucide-react";
import * as React from "react";
import { useFormatter, useTranslations } from "use-intl";
import { useRelativeTimeText } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DATE_TIME } from "@/lib/format-date";
import type { DeployTargetState } from "@/web/api/deploys";
import { DurationText, useDeploymentActorText } from "./timeline";
import {
  deploymentDurationMs,
  type HeaderState,
  type TimelineDeployment,
} from "./timeline-model";

/** What the card's controls do; `pending` is the tag whose request is in flight. */
export type CardActions = {
  deploy(tag: string): Promise<void>;
  rollback(): Promise<void>;
  markRelease(d: TimelineDeployment): void;
  viewLog(d: { runId: string; tag: string }): void;
  pending: string | null;
};

export type HeaderLock = {
  lockedBy: { name: string } | null;
  reason: string;
  expiresAt: string;
} | null;

type ReasonKind =
  | "locked"
  | "latestIsLive"
  | "latestDeploying"
  | "latestHeld"
  | "queued";

const BLOCKED_REASON = {
  latestIsLive: "latestIsLive",
  deploying: "latestDeploying",
  held: "latestHeld",
} as const;

const SHORT_SHA = 7;

// When the deployment ended, or else when it was asked for.
const settledAt = (d: TimelineDeployment) => d.finishedAt ?? d.createdAt;

/**
 * The card header: what runs now (or what failed), the one failure line, the
 * lock, and the primary actions with the reason they are unavailable.
 */
export function TargetHeader({
  target,
  serverName,
  header,
  actions,
  lockedReason,
  lock,
  queuedHint,
  canRun,
  canRollback,
}: {
  target: DeployTargetState;
  serverName: string;
  header: HeaderState;
  actions: CardActions;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  lock: HeaderLock;
  // Set while another deploy in the environment runs first.
  queuedHint: string | null;
  canRun: boolean;
  canRollback: boolean;
}) {
  const t = useTranslations("deploys");
  const reasonId = React.useId();
  const { pending } = actions;
  const latest = canRun ? header.deployLatest : null;
  const rollbackTag = canRollback ? header.rollbackTag : null;

  let reasonKind: ReasonKind | null = null;
  if (latest || rollbackTag) {
    if (lockedReason !== null) {
      reasonKind = "locked";
    } else if (latest?.blocked) {
      reasonKind = BLOCKED_REASON[latest.blocked];
    } else if (queuedHint !== null) {
      reasonKind = "queued";
    }
  }
  const reasonText = (() => {
    switch (reasonKind) {
      case "locked":
        return lockedReason;
      case "latestIsLive":
        return t("latestIsLive", { tag: latest?.tag ?? "" });
      case "latestDeploying":
        return t("latestDeploying");
      case "latestHeld":
        return t("latestHeld");
      case "queued":
        return queuedHint;
      default:
        return null;
    }
  })();

  const deployDisabled =
    latest !== null &&
    (latest.blocked !== null || lockedReason !== null || pending !== null);
  const rollbackDisabled = lockedReason !== null || pending !== null;
  // A blocked rollback is only ever explained by the lock or the queue.
  const rollbackDescribed = reasonKind === "locked" || reasonKind === "queued";

  return (
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{target.componentKey}</span>
        {target.autoDeploy && (
          <Badge variant="secondary">{t("autoDeploy")}</Badge>
        )}
        {lock && <LockChip lock={lock} />}
      </CardTitle>
      <TargetSubtitle target={target} serverName={serverName} />

      {(latest || rollbackTag) && (
        <CardAction className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap justify-end gap-2">
            {rollbackTag && (
              <Button
                variant="outline"
                size="sm"
                disabled={rollbackDisabled}
                aria-disabled={rollbackDisabled || undefined}
                aria-describedby={
                  rollbackDescribed && reasonText ? reasonId : undefined
                }
                onClick={() => actions.rollback()}
              >
                {pending === rollbackTag ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Undo2 data-icon="inline-start" />
                )}
                {t("rollbackTo", { tag: rollbackTag })}
              </Button>
            )}
            {latest && (
              <Button
                size="sm"
                disabled={deployDisabled}
                aria-disabled={deployDisabled || undefined}
                aria-describedby={reasonText ? reasonId : undefined}
                onClick={() => actions.deploy(latest.tag)}
              >
                {pending === latest.tag ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Rocket data-icon="inline-start" />
                )}
                {t("deployLatest", { tag: latest.tag })}
              </Button>
            )}
          </div>
          {reasonText && (
            <p
              id={reasonId}
              data-slot="deploy-actions-reason"
              className="max-w-xs text-end text-xs text-muted-foreground"
            >
              {reasonText}
            </p>
          )}
        </CardAction>
      )}

      <div className="col-span-full flex flex-col gap-1 text-sm">
        <FocalLine focal={header.focal} onViewLog={actions.viewLog} />
        {header.failure && (
          <FailureLine failure={header.failure} onViewLog={actions.viewLog} />
        )}
      </div>
    </CardHeader>
  );
}

// Repo, branch, server and path; wraps on narrow screens instead of clipping.
function TargetSubtitle({
  target,
  serverName,
}: {
  target: DeployTargetState;
  serverName: string;
}) {
  const t = useTranslations("deploys");
  const path =
    target.kind === "jar"
      ? `${target.deployDir}/${target.jarName}`
      : target.deployDir;
  const code = "font-mono text-sm";
  const parts: React.ReactElement[] = [];
  if (target.repoFullName) {
    parts.push(
      <code key="repo" className={code} title={t("serviceRepo")}>
        {target.repoFullName}
      </code>
    );
  }
  parts.push(
    <code key="branch" className={code}>
      {target.sourceBranch}
    </code>
  );
  if (serverName) {
    parts.push(<span key="server">{serverName}</span>);
  }
  parts.push(
    <code key="path" className={code} title={path}>
      {path}
    </code>
  );
  if (target.kind === "jar") {
    parts.push(
      <code key="unit" className={code}>
        {target.systemdUnit}
      </code>
    );
  }
  return (
    <CardDescription className="flex flex-wrap gap-x-1 break-all">
      {parts.map((part, i) => (
        <React.Fragment key={part.key}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          {part}
        </React.Fragment>
      ))}
    </CardDescription>
  );
}

function FocalLine({
  focal,
  onViewLog,
}: {
  focal: HeaderState["focal"];
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const format = useFormatter();
  const relative = useRelativeTimeText();
  const actorText = useDeploymentActorText();

  if (focal.kind === "never") {
    return (
      <p data-slot="deploy-focal" className="italic text-muted-foreground">
        {t("neverDeployed")}
      </p>
    );
  }

  if (focal.kind === "failedCurrent") {
    const d = focal.deployment;
    return (
      <div
        data-slot="deploy-focal"
        role="status"
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-destructive"
      >
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        <span
          title={
            d ? format.dateTime(new Date(settledAt(d)), DATE_TIME) : undefined
          }
        >
          {t("focalFailed", {
            tag: focal.tag,
            time: d ? relative(settledAt(d)) : "",
          })}
        </span>
        {focal.lastGood && (
          <span>{t("focalLastGood", { tag: focal.lastGood })}</span>
        )}
        {d?.runId && (
          <ViewLogButton
            onClick={() => d.runId && onViewLog({ runId: d.runId, tag: d.tag })}
          />
        )}
      </div>
    );
  }

  const d = focal.deployment;
  const duration = d ? deploymentDurationMs(d) : null;
  const sha = focal.commitSha?.slice(0, SHORT_SHA) ?? null;
  return (
    <p
      data-slot="deploy-focal"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <span className="font-medium">{t("focalLive", { tag: focal.tag })}</span>
      {sha &&
        (focal.pipelineUrl ? (
          <a
            href={focal.pipelineUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`${t("viewPipelineFor", { sha })} ${t("opensInNewTab")}`}
            className="inline-flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground"
          >
            {sha}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : (
          <code className="font-mono text-muted-foreground">{sha}</code>
        ))}
      {d && (
        <>
          <span aria-hidden="true"> · </span>
          <span
            className="text-muted-foreground"
            title={format.dateTime(new Date(settledAt(d)), DATE_TIME)}
          >
            {t("focalDeployedBy", {
              time: relative(settledAt(d)),
              actor: actorText(d),
            })}
          </span>
        </>
      )}
      {duration !== null && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="text-muted-foreground">
            <DurationText ms={duration} />
          </span>
        </>
      )}
    </p>
  );
}

function FailureLine({
  failure,
  onViewLog,
}: {
  failure: NonNullable<HeaderState["failure"]>;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const format = useFormatter();
  const relative = useRelativeTimeText();
  const d = failure.deployment;
  return (
    <div
      data-slot="deploy-failure"
      role="status"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-destructive"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <span title={format.dateTime(new Date(settledAt(d)), DATE_TIME)}>
        {t("failureLine", { tag: failure.tag, time: relative(settledAt(d)) })}
      </span>
      {d.runId && (
        <ViewLogButton
          onClick={() => d.runId && onViewLog({ runId: d.runId, tag: d.tag })}
        />
      )}
    </div>
  );
}

function ViewLogButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("deploys");
  return (
    <Button variant="ghost" size="xs" onClick={onClick}>
      <ScrollText data-icon="inline-start" />
      {t("viewLog")}
    </Button>
  );
}

// Who holds the lock and until when; the reason in the tooltip and, for
// screen readers, in the chip's description.
function LockChip({ lock }: { lock: NonNullable<HeaderLock> }) {
  const t = useTranslations("deploys");
  const format = useFormatter();
  const reasonId = React.useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant="outline"
              tabIndex={0}
              aria-describedby={reasonId}
              className="h-auto whitespace-normal"
            />
          }
        >
          <Lock data-icon="inline-start" />
          {t("lockChip", {
            name: lock.lockedBy?.name || t("lock.holderUnknown"),
            time: format.dateTime(new Date(lock.expiresAt), DATE_TIME),
          })}
        </TooltipTrigger>
        <TooltipContent>{lock.reason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {lock.reason}
      </span>
    </>
  );
}
