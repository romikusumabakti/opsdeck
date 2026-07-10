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
import type { ProjectActivity } from "@/actions/runs";
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
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { Environment } from "@/lib/db/schema";

export type SortKey = "recent" | "opened" | "name_asc" | "name_desc";

export function ProjectsGrid({
  projects,
  projectNameById,
  projectKeyById,
  openIssueCounts,
  lastActivity,
  lastOpened,
  initialSort,
}: {
  projects: Environment[];
  projectNameById: Record<string, string>;
  projectKeyById: Record<string, string>;
  openIssueCounts: Record<string, number>;
  lastActivity: Record<string, ProjectActivity | null>;
  lastOpened: Record<string, number>;
  initialSort: SortKey;
}) {
  const t = useTranslations("home");
  const tDash = useTranslations("dashboard");
  const tKinds = useTranslations("environmentKinds");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const router = useRouter();
  const pathname = usePathname();

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>(initialSort);

  // Persist the sort in the URL (?sort=) so it survives reload, back/forward,
  // and is shareable. `recent` is the default, so keep it out of the URL to
  // leave the canonical /projects link clean.
  function changeSort(next: SortKey) {
    setSort(next);
    router.replace(
      next === "recent" ? pathname : { pathname, query: { sort: next } }
    );
  }

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
    const openedAt = (id: string) => lastOpened[id] ?? 0;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "opened":
          return openedAt(b.id) - openedAt(a.id);
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "name_desc":
          return b.name.localeCompare(a.name);
        default:
          return runAt(b.id) - runAt(a.id);
      }
    });
  }, [projects, lastActivity, lastOpened, query, sort]);

  // Group the filtered+sorted environments under their logical project,
  // preserving the within-group order from `visible`. Groups are sorted
  // alphabetically by project name.
  const groups = React.useMemo(() => {
    const byProject = new Map<string, Environment[]>();
    for (const env of visible) {
      const list = byProject.get(env.projectId);
      if (list) {
        list.push(env);
      } else {
        byProject.set(env.projectId, [env]);
      }
    }
    return [...byProject.entries()]
      .map(([projectId, envs]) => ({
        projectId,
        name: projectNameById[projectId] ?? "—",
        envs,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [visible, projectNameById]);

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
        <Select value={sort} onValueChange={(v) => changeSort(v as SortKey)}>
          <SelectTrigger
            className="sm:ms-auto sm:w-56"
            aria-label={t("sortLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t("sortRecent")}</SelectItem>
            <SelectItem value="opened">{t("sortOpened")}</SelectItem>
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
        <div className="flex flex-col gap-6">
          {groups.map((group) => {
            const openCount = openIssueCounts[group.projectId] ?? 0;
            const projectKey = projectKeyById[group.projectId];
            return (
              <section key={group.projectId} className="flex flex-col gap-3">
                <div className="flex items-baseline gap-2">
                  {projectKey ? (
                    <Link
                      href={`/project/${projectKey}`}
                      className="text-sm font-semibold truncate hover:underline"
                    >
                      {group.name}
                    </Link>
                  ) : (
                    <h2 className="text-sm font-semibold truncate">
                      {group.name}
                    </h2>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t("environmentCount", { count: group.envs.length })}
                  </span>
                  {openCount > 0 ? (
                    <span className="text-xs text-muted-foreground shrink-0">
                      · {t("openIssues", { count: openCount })}
                    </span>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
                  {group.envs.map((project) => (
                    <EnvironmentCard
                      key={project.id}
                      project={project}
                      projectName={group.name}
                      activity={lastActivity[project.id] ?? null}
                      dateFnsLocale={dateFnsLocale}
                      neverText={t("neverActive")}
                      dbTypeLabel={tDash(`dbTypes.${project.dbType}`)}
                      kindLabel={project.kind ? tKinds(project.kind) : null}
                      ownerLabel={
                        project.owner
                          ? t("ownedBy", { owner: project.owner })
                          : null
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Drop the redundant project-name prefix now that the card sits under that
// project's heading (e.g. "CAR Membership P2SK (137)" -> "P2SK (137)").
function stripProjectPrefix(envName: string, projectName: string): string {
  if (
    projectName &&
    envName.toLowerCase().startsWith(projectName.toLowerCase())
  ) {
    const rest = envName.slice(projectName.length).replace(/^[\s:–—-]+/, "");
    return rest.trim() || envName;
  }
  return envName;
}

function EnvironmentCard({
  project,
  projectName,
  activity,
  dateFnsLocale,
  neverText,
  dbTypeLabel,
  kindLabel,
  ownerLabel,
}: {
  project: Environment;
  projectName: string;
  activity: ProjectActivity | null;
  dateFnsLocale: ReturnType<typeof getDateFnsLocale>;
  neverText: string;
  dbTypeLabel: string;
  kindLabel: string | null;
  ownerLabel: string | null;
}) {
  const displayName = stripProjectPrefix(project.name, projectName);
  return (
    <Link
      href={`/projects/${project.id}`}
      className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
    >
      <Card className="h-full py-0 hover:border-primary/50 hover:shadow-sm transition-all">
        <CardContent className="p-4 flex flex-col gap-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium truncate">{displayName}</span>
              {kindLabel ? (
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase shrink-0"
                >
                  {kindLabel}
                </Badge>
              ) : null}
            </div>
            <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
          </div>
          <div className="flex items-center gap-2 text-sm min-w-0">
            <Badge variant="secondary" className="text-xs shrink-0">
              {dbTypeLabel}
            </Badge>
            <code className="font-mono text-xs text-muted-foreground truncate">
              {project.dbName}
            </code>
          </div>
          {ownerLabel ? (
            <span className="text-xs text-muted-foreground truncate">
              {ownerLabel}
            </span>
          ) : null}
          <ActivityRow
            activity={activity}
            dateFnsLocale={dateFnsLocale}
            neverText={neverText}
          />
        </CardContent>
      </Card>
    </Link>
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
