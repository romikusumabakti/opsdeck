"use client";

import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import type { ProjectActivity } from "@/actions/tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { Project } from "@/lib/db/schema";

type SortKey = "recent" | "name_asc" | "name_desc";

export function ProjectsGrid({
  projects,
  lastActivity,
}: {
  projects: Project[];
  lastActivity: Record<string, ProjectActivity | null>;
}) {
  const t = useTranslations("home");
  const tDash = useTranslations("dashboard");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("recent");

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.dbName.toLowerCase().includes(q)
        )
      : projects;
    const runAt = (id: string) => {
      const a = lastActivity[id];
      return a ? new Date(a.runAt).getTime() : 0;
    };
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "name_desc":
          return b.name.localeCompare(a.name);
        default:
          return runAt(b.id) - runAt(a.id);
      }
    });
  }, [projects, lastActivity, query, sort]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="ps-9"
            aria-label={t("searchPlaceholder")}
          />
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger
            className="sm:ms-auto sm:w-56"
            aria-label={t("sortLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t("sortRecent")}</SelectItem>
            <SelectItem value="name_asc">{t("sortNameAsc")}</SelectItem>
            <SelectItem value="name_desc">{t("sortNameDesc")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t("noMatch", { query: query.trim() })}
          </p>
          <Button variant="outline" size="sm" onClick={() => setQuery("")}>
            {t("clearSearch")}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
          {visible.map((project) => {
            const activity = lastActivity[project.id] ?? null;
            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
              >
                <Card className="h-full py-0 hover:border-primary/50 hover:shadow-sm transition-all">
                  <CardContent className="p-4 flex flex-col gap-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="size-9 rounded-md bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">
                          {project.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="font-medium truncate">
                          {project.name}
                        </span>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <div className="flex items-center gap-2 text-sm min-w-0">
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {tDash(`dbTypes.${project.dbType}`)}
                      </Badge>
                      <code className="font-mono text-xs text-muted-foreground truncate">
                        {project.dbName}
                      </code>
                    </div>
                    <ActivityRow
                      activity={activity}
                      dateFnsLocale={dateFnsLocale}
                      neverText={t("neverActive")}
                    />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  activity,
  dateFnsLocale,
  neverText,
}: {
  activity: ProjectActivity | null;
  dateFnsLocale: ReturnType<typeof getDateFnsLocale>;
  neverText: string;
}) {
  if (!activity) {
    return (
      <span className="text-xs text-muted-foreground italic">{neverText}</span>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
      <StatusDot status={activity.status} />
      <span className="truncate">
        {formatDistanceToNow(new Date(activity.runAt), {
          addSuffix: true,
          locale: dateFnsLocale,
        })}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: ProjectActivity["status"] }) {
  if (status === "started") {
    return <Loader2 className="size-3 text-primary animate-spin shrink-0" />;
  }
  if (status === "failed") {
    return <CircleAlert className="size-3 text-destructive shrink-0" />;
  }
  return <CheckCircle2 className="size-3 text-success shrink-0" />;
}
