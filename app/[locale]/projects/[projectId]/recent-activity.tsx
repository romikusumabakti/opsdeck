import { formatDistanceToNow, type Locale } from "date-fns";
import { Activity, CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { getProjectTasks, type TaskWithUser } from "@/actions/tasks";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

const RECENT_LIMIT = 5;

export async function RecentActivity({ projectId }: { projectId: string }) {
  // Re-uses the existing query so we don't multiply DB round-trips. Trimmed
  // here rather than via SQL because the list is bounded by project scope.
  const tasks = (await getProjectTasks(projectId)).slice(0, RECENT_LIMIT);
  const t = await getTranslations("dashboard.recentActivity");
  const locale = await getLocale();
  const dateFnsLocale = getDateFnsLocale(locale);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">{t("title")}</CardTitle>
        </div>
        {tasks.length > 0 && (
          <Link
            href={`/projects/${projectId}/history`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("viewAll")}
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col">
            {tasks.map((task, i) => (
              <li
                key={task.id}
                className={i === 0 ? "py-2" : "py-2 border-t border-border/40"}
              >
                <ActivityRow task={task} dateFnsLocale={dateFnsLocale} t={t} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  task,
  dateFnsLocale,
  t,
}: {
  task: TaskWithUser;
  dateFnsLocale: Locale | undefined;
  t: (key: string) => string;
}) {
  const relative = formatDistanceToNow(new Date(task.runAt), {
    addSuffix: true,
    locale: dateFnsLocale,
  });
  return (
    <div className="flex items-center gap-3">
      <StatusGlyph status={task.status} />
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-sm truncate">{task.description}</span>
        <span className="text-xs text-muted-foreground">
          {relative}
          {task.user ? ` · ${task.user.name}` : ""}
        </span>
      </div>
      <StatusBadge status={task.status} t={t} />
    </div>
  );
}

function StatusGlyph({ status }: { status: TaskWithUser["status"] }) {
  if (status === "success") {
    return (
      <span className="size-7 rounded-full bg-success/15 text-success flex items-center justify-center shrink-0">
        <CheckCircle2 className="size-3.5" />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="size-7 rounded-full bg-destructive/15 text-destructive flex items-center justify-center shrink-0">
        <CircleAlert className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="size-7 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
      <Loader2 className="size-3.5 animate-spin" />
    </span>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: TaskWithUser["status"];
  t: (key: string) => string;
}) {
  if (status === "success") {
    return (
      <Badge
        variant="secondary"
        className="bg-success/15 text-success border-transparent text-[10px] uppercase tracking-wide"
      >
        {t("statusSuccess")}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge
        variant="destructive"
        className="text-[10px] uppercase tracking-wide"
      >
        {t("statusFailed")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
      {t("statusRunning")}
    </Badge>
  );
}

export function RecentActivitySkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-5 w-32" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-7 rounded-full shrink-0" />
            <div className="flex-1 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-5 w-14" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
