import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  History,
  Loader2,
  Lock,
  ShieldCheck,
  SkipForward,
} from "lucide-react";
import * as React from "react";
import { useNow, useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DeployTargetState } from "@/web/api/deploys";
import {
  DeploymentActor,
  DurationText,
  useDurationText,
  ViewLogButton,
} from "./deployment-parts";
import { FirstBuild, WaitingForFirstBuild } from "./first-build";
import { TimelineRowMenu } from "./row-menu";
import type { CardActions } from "./target-header";
import {
  deploymentDurationMs,
  elapsedMs,
  logDeployment,
  type RowActionPlan,
  rowActions,
  shortSha,
  type TimelineDeployment,
  type TimelineRow,
} from "./timeline-model";

type Deployment = DeployTargetState["recentDeployments"][number];

/** Rows shown at first, and how many more each "Show more" adds. */
export const PAGE_FIRST = 10;
export const PAGE_MORE = 20;

const ELAPSED_TICK_MS = 1000;

export type TimelineContext = Parameters<typeof rowActions>[1];

/**
 * One row per tag (builds and deployed tags merged), newest first, each with
 * its status, who deployed it, its earlier deploys and a ⋯ menu.
 */
export function Timeline({
  target,
  rows,
  actions,
  ctx,
  lockedReason,
  queuedHint,
}: {
  target: DeployTargetState;
  rows: TimelineRow[];
  actions: CardActions;
  ctx: TimelineContext;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  // Set while another deploy in the environment runs first.
  queuedHint: string | null;
}) {
  const t = useTranslations("deploys");
  const [shown, setShown] = React.useState(PAGE_FIRST);
  const listRef = React.useRef<HTMLUListElement>(null);
  // Index of the first row a "Show more" click revealed, to move focus onto.
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null);
  const remaining = rows.length - shown;
  React.useEffect(() => {
    if (focusIndex === null) return;
    listRef.current
      ?.querySelectorAll<HTMLElement>('[data-slot="timeline-row"]')
      [focusIndex]?.focus();
    setFocusIndex(null);
  }, [focusIndex]);
  const firstBuild = target.repoFullName !== null && (
    <FirstBuild
      componentKey={target.componentKey}
      branch={target.sourceBranch}
      canStart={ctx.canRun}
      deploysOnArrival={target.autoDeploy || target.deployNextBuild}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      {target.deployNextBuild && (
        <WaitingForFirstBuild branch={target.sourceBranch} />
      )}
      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("buildsEmpty", { branch: target.sourceBranch })}
          </p>
          {firstBuild}
        </div>
      ) : (
        <>
          {/* Only deployed tags of other branches: the branch still needs
              its first build before anything new can be deployed. */}
          {target.recentBuilds.length === 0 && firstBuild && (
            <div className="flex justify-end">{firstBuild}</div>
          )}
          <ul
            ref={listRef}
            // biome-ignore lint/a11y/noRedundantRoles: list-none drops the list role in Safari.
            role="list"
            className="flex list-none flex-col divide-y"
          >
            {rows.slice(0, shown).map((row) => (
              <TimelineRowItem
                key={row.tag}
                row={row}
                plans={rowActions(row, ctx)}
                actions={actions}
                lockedReason={lockedReason}
                queuedHint={queuedHint}
                sourceBranch={target.sourceBranch}
              />
            ))}
          </ul>
          {remaining > 0 && (
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onClick={() => {
                setFocusIndex(shown);
                setShown((n) => n + PAGE_MORE);
              }}
            >
              {t("showMore", { count: Math.min(PAGE_MORE, remaining) })}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function TimelineRowItem({
  row,
  plans,
  actions,
  lockedReason,
  queuedHint,
  sourceBranch,
}: {
  row: TimelineRow;
  plans: RowActionPlan[];
  actions: CardActions;
  lockedReason: string | null;
  queuedHint: string | null;
  sourceBranch: string;
}) {
  const sha = shortSha(row.commitSha);
  const [tagRef, tagOverflows] = useOverflowsInline<HTMLSpanElement>();
  const shownAt =
    row.receivedAt ??
    row.subject?.createdAt ??
    row.deployments[0]?.createdAt ??
    null;

  return (
    <li
      // biome-ignore lint/a11y/noRedundantRoles: list-none drops the list role in Safari.
      role="listitem"
      data-slot="timeline-row"
      data-status={row.status}
      // Not a tab stop: "Show more" moves focus here.
      tabIndex={-1}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_8rem_minmax(0,14rem)_auto]",
        "items-start rounded-lg px-2 py-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        row.status === "live" && "bg-success/5"
      )}
    >
      {/* Below md the tag and status share line 1; from md both become
          grid cells of their own. */}
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 md:contents">
        <span
          ref={tagRef}
          data-slot="tag-scroll"
          // The one scrollable box: a long tag scrolls here, not the card.
          // Only a tag that overflows is a tab stop, so keyboard users can
          // scroll it; one that fits adds nothing to the tab order.
          {...(tagOverflows && {
            tabIndex: 0,
            role: "group",
            "aria-label": row.tag,
          })}
          className="max-w-full min-w-0 overflow-x-auto whitespace-nowrap md:col-start-1 md:row-start-1"
        >
          <span data-slot="row-tag" className="font-mono text-sm">
            {row.tag}
          </span>
        </span>
        <div className="flex min-w-0 flex-col gap-1 md:col-start-4 md:row-start-1">
          <RowStatus row={row} onViewLog={actions.viewLog} />
          <SubjectMeta deployment={row.subject} />
          <RowHistory row={row} onViewLog={actions.viewLog} />
        </div>
      </div>
      <div
        data-slot="row-commit"
        className="col-span-1 flex min-w-0 flex-col md:col-start-2 md:row-start-1"
      >
        <span
          className="flex min-w-0 items-baseline gap-2 text-sm"
          title={row.build?.commitAuthorEmail ?? undefined}
        >
          {sha && (
            <code
              className="shrink-0 font-mono text-muted-foreground"
              title={row.commitSha ?? undefined}
            >
              {sha}
            </code>
          )}
          {row.commitMessage && (
            <span className="truncate" title={row.commitMessage}>
              {row.commitMessage}
            </span>
          )}
        </span>
        {shownAt && (
          <span
            data-slot="row-received"
            className="text-xs text-muted-foreground md:hidden"
          >
            <RelativeTime date={shownAt} />
          </span>
        )}
      </div>
      <span
        data-slot="row-time"
        className="hidden text-sm text-muted-foreground md:col-start-3 md:row-start-1 md:block"
      >
        {shownAt && <RelativeTime date={shownAt} />}
      </span>
      <div className="col-start-2 row-span-2 row-start-1 self-start md:col-start-5 md:row-span-1">
        <TimelineRowMenu
          row={row}
          plans={plans}
          actions={actions}
          lockedReason={lockedReason}
          queuedHint={queuedHint}
          sourceBranch={sourceBranch}
        />
      </div>
    </li>
  );
}

// Whether the element's content is wider than its box, kept up to date as
// the box resizes.
function useOverflowsInline<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [overflows, setOverflows] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, overflows] as const;
}

function StatusLine({
  icon: Icon,
  className,
  iconClassName,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  className?: string;
  iconClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <Icon className={cn("size-4 shrink-0", iconClassName)} aria-hidden />
      {children}
    </span>
  );
}

// Always an icon plus text; the deploying and failed states link their log.
function RowStatus({
  row,
  onViewLog,
}: {
  row: TimelineRow;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const log = logDeployment(row);
  const viewLog = log?.runId ? (
    <ViewLogButton
      onClick={() => log.runId && onViewLog({ runId: log.runId, tag: row.tag })}
    />
  ) : null;

  const content = (() => {
    switch (row.status) {
      case "live":
        return (
          <>
            <Badge className="border-transparent bg-success/15 text-success">
              <CheckCircle2 data-icon="inline-start" />
              {t("row.live")}
            </Badge>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      case "previous":
        return (
          <>
            <StatusLine icon={History}>{t("row.previous")}</StatusLine>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      case "lastGood":
        return (
          <>
            <StatusLine icon={ShieldCheck}>{t("row.lastGood")}</StatusLine>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      case "queued":
        return (
          <StatusLine icon={Loader2} iconClassName="animate-spin">
            {t("row.queued")}
          </StatusLine>
        );
      case "deploying":
        return (
          <>
            <StatusLine icon={Loader2} iconClassName="animate-spin">
              <DeployingLabel deployment={row.subject} />
            </StatusLine>
            {viewLog}
          </>
        );
      case "held":
        return <StatusLine icon={Lock}>{t("row.held")}</StatusLine>;
      case "failed":
        return (
          <>
            <StatusLine icon={CircleAlert} className="text-destructive">
              {t("row.failed")}
            </StatusLine>
            {viewLog}
          </>
        );
      case "skipped":
        return (
          <StatusLine icon={SkipForward} className="text-muted-foreground">
            {t("row.skipped")}
          </StatusLine>
        );
      case "deployedEarlier": {
        const d = row.subject;
        return (
          <>
            <StatusLine icon={CheckCircle2} className="text-muted-foreground">
              {t("row.deployedEarlier")}{" "}
              {d && <RelativeTime date={d.finishedAt ?? d.createdAt} />}
            </StatusLine>
            <LaterFailure row={row} onViewLog={onViewLog} />
          </>
        );
      }
      default:
        return (
          <span className="text-sm text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t("row.never")}</span>
          </span>
        );
    }
  })();

  return (
    <div
      data-slot="row-status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      {content}
    </div>
  );
}

// A failed redeploy after the row's success, so the row shows the failure.
function LaterFailure({
  row,
  onViewLog,
}: {
  row: TimelineRow;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  const d = row.laterFailure;
  if (!d) return null;
  return (
    <span
      data-slot="row-later-failure"
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <StatusLine icon={CircleAlert} className="text-destructive">
        {t("row.redeployFailed")}
      </StatusLine>
      {d.runId && (
        <ViewLogButton
          onClick={() => d.runId && onViewLog({ runId: d.runId, tag: d.tag })}
        />
      )}
    </span>
  );
}

// Ticks every second while mounted, so only deploying rows re-render.
function DeployingLabel({
  deployment,
}: {
  deployment: TimelineDeployment | null;
}) {
  const t = useTranslations("deploys");
  const now = useNow({ updateInterval: ELAPSED_TICK_MS });
  const duration = useDurationText();
  const elapsed = deployment ? elapsedMs(deployment, now) : null;
  if (elapsed === null) return t("row.deployingNoTime");
  return t("row.deploying", { elapsed: duration(Math.max(0, elapsed)) ?? "" });
}

// Who deployed, whether it was a rollback, and how long it took.
function SubjectMeta({
  deployment: d,
}: {
  deployment: TimelineDeployment | null;
}) {
  const t = useTranslations("deploys");
  if (!d) return null;
  const duration = deploymentDurationMs(d);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <DeploymentActor deployment={d} />
      {d.trigger === "rollback" && (
        <>
          <span aria-hidden="true">·</span>
          <span>{t("trigger.rollback")}</span>
        </>
      )}
      {duration !== null && (
        <>
          <span aria-hidden="true">·</span>
          <DurationText ms={duration} />
        </>
      )}
    </span>
  );
}

// The tag's other deployments, so the history of who deployed what stays.
function RowHistory({
  row,
  onViewLog,
}: {
  row: TimelineRow;
  onViewLog: CardActions["viewLog"];
}) {
  const t = useTranslations("deploys");
  if (row.deployments.length < 2) return null;
  const shownId = row.subject?.id ?? row.deployments[0]?.id;
  const earlier = row.deployments.filter((d) => d.id !== shownId);
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="group/history -ms-2 self-start text-muted-foreground"
          />
        }
      >
        {t("row.history", { count: earlier.length })}
        <ChevronDown
          data-icon="inline-end"
          className="transition-transform group-data-[panel-open]/history:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex list-none flex-col gap-1.5 pt-1">
          {earlier.map((d) => {
            const duration = deploymentDurationMs(d);
            return (
              <li
                key={d.id}
                data-slot="history-entry"
                className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
              >
                <DeploymentStatusBadge status={d.status} />
                <span>{t(`trigger.${d.trigger}`)}</span>
                <span aria-hidden="true">·</span>
                <DeploymentActor deployment={d} />
                <span aria-hidden="true">·</span>
                <RelativeTime date={d.createdAt} />
                {duration !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <DurationText ms={duration} />
                  </>
                )}
                {d.runId && (
                  <ViewLogButton
                    onClick={() =>
                      d.runId && onViewLog({ runId: d.runId, tag: d.tag })
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DeploymentStatusBadge({ status }: { status: Deployment["status"] }) {
  const t = useTranslations("deploys");
  const label = t(`status.${status}`);
  switch (status) {
    case "success":
      return (
        <Badge className="bg-success/15 text-success border-transparent">
          <CheckCircle2 data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <CircleAlert data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary">
          <Loader2 data-icon="inline-start" className="animate-spin" />
          {label}
        </Badge>
      );
    case "superseded":
      return <Badge variant="outline">{label}</Badge>;
    case "held":
      return (
        <Badge variant="outline">
          <Lock data-icon="inline-start" />
          {label}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{label}</Badge>;
  }
}
