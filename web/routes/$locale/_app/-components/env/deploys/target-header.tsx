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

/** A deploy or rollback whose request is in flight. */
export type PendingAction = { kind: "deploy" | "rollback"; tag: string };

/** What the card's controls do; `pending` is the request in flight. */
export type CardActions = {
  deploy(tag: string): Promise<void>;
  rollback(): Promise<void>;
  markRelease(d: TimelineDeployment): void;
  viewLog(d: { runId: string; tag: string }): void;
  pending: PendingAction | null;
};

export type HeaderLock = {
  lockedBy: { name: string } | null;
  reason: string;
  expiresAt: string;
} | null;

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
  const deployReasonId = React.useId();
  const rollbackReasonId = React.useId();
  const { pending } = actions;
  const latest = canRun ? header.deployLatest : null;
  const rollbackTag = canRollback ? header.rollbackTag : null;

  // Why each button is off (or, for the queue, when it starts).
  const deployReason = (() => {
    if (!latest) return null;
    if (lockedReason !== null) return lockedReason;
    switch (latest.blocked) {
      case "latestIsLive":
        return t("latestIsLive", { tag: latest.tag });
      case "deploying":
        return t("latestDeploying");
      case "held":
        return t("latestHeld");
      default:
        return queuedHint;
    }
  })();
  const rollbackReason = (() => {
    if (!rollbackTag) return null;
    if (lockedReason !== null) return lockedReason;
    if (header.rollbackBusy) {
      return t("rollbackInProgress", { tag: rollbackTag });
    }
    return queuedHint;
  })();
  // One line when both buttons share the reason.
  const sharedReason = deployReason !== null && deployReason === rollbackReason;
  const reasons = [
    deployReason !== null && { id: deployReasonId, text: deployReason },
    rollbackReason !== null &&
      !sharedReason && { id: rollbackReasonId, text: rollbackReason },
  ].filter((r) => r !== false);

  const deployDisabled =
    latest !== null &&
    (latest.blocked !== null || lockedReason !== null || pending !== null);
  const rollbackDisabled =
    lockedReason !== null || pending !== null || header.rollbackBusy;

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
        <CardAction className="col-start-1 row-span-1 row-start-auto flex flex-col items-start gap-1.5 justify-self-start md:col-start-2 md:row-span-2 md:row-start-1 md:items-end md:justify-self-end">
          <div className="flex flex-wrap justify-start gap-2 md:justify-end">
            {rollbackTag && (
              <Button
                variant="outline"
                size="sm"
                disabled={rollbackDisabled}
                aria-disabled={rollbackDisabled || undefined}
                aria-describedby={
                  rollbackReason === null
                    ? undefined
                    : sharedReason
                      ? deployReasonId
                      : rollbackReasonId
                }
                onClick={() => actions.rollback()}
              >
                {pending?.kind === "rollback" ? (
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
                aria-describedby={
                  deployReason === null ? undefined : deployReasonId
                }
                onClick={() => actions.deploy(latest.tag)}
              >
                {pending?.kind === "deploy" && pending.tag === latest.tag ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Rocket data-icon="inline-start" />
                )}
                {t("deployLatest", { tag: latest.tag })}
              </Button>
            )}
          </div>
          {reasons.map((r) => (
            <p
              key={r.id}
              id={r.id}
              data-slot="deploy-actions-reason"
              className="max-w-xs text-start text-xs md:text-end text-muted-foreground"
            >
              {r.text}
            </p>
          ))}
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
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-destructive"
      >
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        <span
          title={
            d ? format.dateTime(new Date(settledAt(d)), DATE_TIME) : undefined
          }
        >
          {d
            ? t("focalFailed", { tag: focal.tag, time: relative(settledAt(d)) })
            : t("focalFailedNoTime", { tag: focal.tag })}
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
