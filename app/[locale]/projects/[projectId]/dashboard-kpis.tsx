import { formatDistanceToNow, type Locale } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  Database,
  DatabaseBackup,
  Loader2,
  TrendingUp,
} from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { getProjectKpis, type KpiEntry } from "@/actions/tasks";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Task } from "@/lib/db/schema";

export async function DashboardKpis({ projectId }: { projectId: string }) {
  const [kpis, t, locale, format] = await Promise.all([
    getProjectKpis(projectId),
    getTranslations("dashboard.kpis"),
    getLocale(),
    getFormatter(),
  ]);
  const dateFnsLocale = locale === "id" ? idLocale : undefined;

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
        label={t("lastSimulate")}
        entry={kpis.lastSimulate}
        dateFnsLocale={dateFnsLocale}
        format={format}
        emptyText={t("never")}
      />
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <span className="text-xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1.5">
            <TrendingUp className="size-3" />
            {t("activity7d")}
          </span>
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-2xl font-semibold tabular-nums">
              {kpis.totalRuns7d}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {t("runs")}
            </span>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {kpis.successRate7d === null
              ? t("noCompleted")
              : t("successRate", { pct: kpis.successRate7d })}
          </span>
        </CardContent>
      </Card>
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

function StatusDot({ status }: { status: Task["status"] }) {
  if (status === "started") {
    return <Loader2 className="size-3 text-primary animate-spin shrink-0" />;
  }
  if (status === "failed") {
    return <CircleAlert className="size-3 text-destructive shrink-0" />;
  }
  return <CheckCircle2 className="size-3 text-emerald-500 shrink-0" />;
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
