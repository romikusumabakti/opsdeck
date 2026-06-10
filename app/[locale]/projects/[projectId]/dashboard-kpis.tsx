import { formatDistanceToNow, type Locale } from "date-fns";
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Clock,
  Database,
  DatabaseBackup,
  Loader2,
  Minus,
  TrendingUp,
} from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { getProjectKpis, type KpiEntry } from "@/actions/tasks";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { Task } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export async function DashboardKpis({ projectId }: { projectId: string }) {
  const [kpis, t, locale, format] = await Promise.all([
    getProjectKpis(projectId),
    getTranslations("dashboard.kpis"),
    getLocale(),
    getFormatter(),
  ]);
  const dateFnsLocale = getDateFnsLocale(locale);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <KpiCard
        icon={Database}
        label={t("lastBackup")}
        entry={kpis.lastBackup}
        dateFnsLocale={dateFnsLocale}
        format={format}
        emptyText={t("never")}
      />
      <KpiCard
        icon={DatabaseBackup}
        label={t("lastRestore")}
        entry={kpis.lastRestore}
        dateFnsLocale={dateFnsLocale}
        format={format}
        emptyText={t("never")}
      />
      <KpiCard
        icon={Clock}
        label={t("lastMock")}
        entry={kpis.lastMock}
        dateFnsLocale={dateFnsLocale}
        format={format}
        emptyText={t("never")}
      />
      <ActivityKpiCard
        label={t("activity7d")}
        total={kpis.totalRuns7d}
        prevTotal={kpis.prevTotalRuns7d}
        daily={kpis.dailyRuns}
        runsLabel={t("runs")}
        successRate7d={kpis.successRate7d}
        successRateLabel={(pct) => t("successRate", { pct })}
        noCompletedLabel={t("noCompleted")}
        deltaUpLabel={t("deltaUp")}
        deltaDownLabel={t("deltaDown")}
        deltaFlatLabel={t("deltaFlat")}
        sparklineLabel={t("sparklineLabel")}
      />
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  entry,
  dateFnsLocale,
  format,
  emptyText,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  entry: KpiEntry;
  dateFnsLocale: Locale | undefined;
  format: Awaited<ReturnType<typeof getFormatter>>;
  emptyText: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <span className="text-xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1.5">
          <Icon className="size-3" />
          {label}
        </span>
        {entry ? (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <StatusDot status={entry.status} />
              <span className="text-sm font-medium truncate">
                {formatDistanceToNow(new Date(entry.runAt), {
                  addSuffix: true,
                  locale: dateFnsLocale,
                })}
              </span>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {format.dateTime(new Date(entry.runAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground italic">
            {emptyText}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityKpiCard({
  label,
  total,
  prevTotal,
  daily,
  runsLabel,
  successRate7d,
  successRateLabel,
  noCompletedLabel,
  deltaUpLabel,
  deltaDownLabel,
  deltaFlatLabel,
  sparklineLabel,
}: {
  label: string;
  total: number;
  prevTotal: number;
  daily: number[];
  runsLabel: string;
  successRate7d: number | null;
  successRateLabel: (pct: number) => string;
  noCompletedLabel: string;
  deltaUpLabel: string;
  deltaDownLabel: string;
  deltaFlatLabel: string;
  sparklineLabel: string;
}) {
  // Delta direction: up when there's more activity this week than last,
  // down when less. When the prior window had zero runs we can't compute
  // a percentage — treat any new activity as "up" and silence the badge
  // otherwise (avoids "+Infinity%" or a misleading 0%).
  const diff = total - prevTotal;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const showDelta = !(direction === "flat" && total === 0);
  const pct =
    prevTotal === 0
      ? total > 0
        ? null
        : 0
      : Math.round((diff / prevTotal) * 100);
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <span className="text-xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1.5">
          <TrendingUp className="size-3" />
          {label}
        </span>
        <div className="flex items-end justify-between gap-3 min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-2xl font-semibold tabular-nums">
                {total}
              </span>
              <span className="text-xs text-muted-foreground truncate">
                {runsLabel}
              </span>
            </div>
            {showDelta && (
              <DeltaBadge
                direction={direction}
                diff={diff}
                pct={pct}
                upLabel={deltaUpLabel}
                downLabel={deltaDownLabel}
                flatLabel={deltaFlatLabel}
              />
            )}
          </div>
          <Sparkline
            data={daily}
            className="text-primary shrink-0"
            ariaLabel={sparklineLabel}
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {successRate7d === null
            ? noCompletedLabel
            : successRateLabel(successRate7d)}
        </span>
      </CardContent>
    </Card>
  );
}

function DeltaBadge({
  direction,
  diff,
  pct,
  upLabel,
  downLabel,
  flatLabel,
}: {
  direction: "up" | "down" | "flat";
  diff: number;
  pct: number | null;
  upLabel: string;
  downLabel: string;
  flatLabel: string;
}) {
  const Icon =
    direction === "up"
      ? ArrowUpRight
      : direction === "down"
        ? ArrowDownRight
        : Minus;
  const colorClass =
    direction === "up"
      ? "text-success"
      : direction === "down"
        ? "text-destructive"
        : "text-muted-foreground";
  const ariaLabel =
    direction === "up" ? upLabel : direction === "down" ? downLabel : flatLabel;
  // When the prior window was empty we can't render a percentage. Fall back
  // to the raw delta (e.g. "+3") so the number is still informative.
  const text =
    pct === null
      ? `${diff > 0 ? "+" : ""}${diff}`
      : `${pct > 0 ? "+" : ""}${pct}%`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs tabular-nums",
        colorClass
      )}
      role="img"
      aria-label={ariaLabel}
    >
      <Icon className="size-3" aria-hidden="true" />
      {direction === "flat" ? flatLabel : text}
    </span>
  );
}

function StatusDot({ status }: { status: Task["status"] }) {
  if (status === "started") {
    return <Loader2 className="size-3 text-primary animate-spin shrink-0" />;
  }
  if (status === "failed") {
    return <CircleAlert className="size-3 text-destructive shrink-0" />;
  }
  return <CheckCircle2 className="size-3 text-success shrink-0" />;
}

export function DashboardKpisSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i}>
          <CardContent className="flex flex-col gap-2 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
