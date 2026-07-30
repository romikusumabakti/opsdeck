"use client";

import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import type { ProjectWithEnvironments } from "@/actions/project-catalog";
import type { EnvironmentActivity } from "@/actions/runs";
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
import type { EnvironmentSummary } from "@/lib/db/schema";

export type SortKey = "recent" | "opened" | "name_asc" | "name_desc";

// Kind decides an environment's position within its project so the list reads
// promotion-order (prod last) instead of alphabetically shuffled per project.
const KIND_ORDER: Record<string, number> = {
  dev: 0,
  qa: 1,
  sandbox: 2,
  release: 3,
  prod: 4,
};

export function ProjectsOverview({
  projects,
  openIssueCounts,
  lastActivity,
  lastOpened,
  initialSort,
  canCreate,
}: {
  projects: ProjectWithEnvironments[];
  openIssueCounts: Record<string, number>;
  lastActivity: Record<string, EnvironmentActivity | null>;
  lastOpened: Record<string, number>;
  initialSort: SortKey;
  canCreate: boolean;
}) {
  const t = useTranslations("home");
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

  // A project's recency is its most recently touched environment; same for
  // "recently opened". Projects with no environments fall to the bottom of
  // both activity sorts but stay visible (they still need a first deployment).
  const activityOf = React.useCallback(
    (p: ProjectWithEnvironments) =>
      Math.max(
        0,
        ...p.environments.map((env) => {
          const a = lastActivity[env.id];
          return a ? new Date(a.runAt).getTime() : 0;
        })
      ),
    [lastActivity]
  );
  const openedOf = React.useCallback(
    (p: ProjectWithEnvironments) =>
      Math.max(0, ...p.environments.map((env) => lastOpened[env.id] ?? 0)),
    [lastOpened]
  );

  // Search spans both levels: a project matches on its own name/key/client (and
  // keeps all its environments), otherwise it survives only through the
  // environments whose name or database matches — so typing "qa" narrows each
  // project down to its QA deployment instead of hiding the project entirely.
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered: ProjectWithEnvironments[] = [];
    for (const p of projects) {
      if (!q) {
        filtered.push(p);
        continue;
      }
      const projectHit =
        p.name.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (p.client ?? "").toLowerCase().includes(q);
      if (projectHit) {
        filtered.push(p);
        continue;
      }
      const envs = p.environments.filter(
        (env) =>
          env.name.toLowerCase().includes(q) ||
          (env.dbName ?? "").toLowerCase().includes(q)
      );
      if (envs.length > 0) filtered.push({ ...p, environments: envs });
    }
    const sorted = [...filtered];
    switch (sort) {
      case "recent":
        sorted.sort((a, b) => activityOf(b) - activityOf(a));
        break;
      case "opened":
        sorted.sort((a, b) => openedOf(b) - openedOf(a));
        break;
      case "name_asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name_desc":
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
    }
    return sorted;
  }, [projects, query, sort, activityOf, openedOf]);

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
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              openIssues={openIssueCounts[project.id] ?? 0}
              lastActivity={lastActivity}
              dateFnsLocale={dateFnsLocale}
              canCreate={canCreate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  openIssues,
  lastActivity,
  dateFnsLocale,
  canCreate,
}: {
  project: ProjectWithEnvironments;
  openIssues: number;
  lastActivity: Record<string, EnvironmentActivity | null>;
  dateFnsLocale: ReturnType<typeof getDateFnsLocale>;
  canCreate: boolean;
}) {
  const t = useTranslations("home");
  const environments = [...project.environments].sort(
    (a, b) =>
      (KIND_ORDER[a.kind ?? ""] ?? 99) - (KIND_ORDER[b.kind ?? ""] ?? 99) ||
      a.name.localeCompare(b.name)
  );

  return (
    <Card className="py-0 overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-start gap-2 px-4 py-3 border-b">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <Link
                href={`/${project.key}`}
                className="font-medium truncate hover:underline"
              >
                {project.name}
              </Link>
              <Badge
                variant="secondary"
                className="font-mono text-[10px] shrink-0"
              >
                {project.key}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
              {project.client ? (
                <span className="truncate">{project.client}</span>
              ) : null}
              <span className="shrink-0">
                {t("environmentCount", { count: project.environments.length })}
              </span>
              {openIssues > 0 ? (
                <span className="shrink-0">
                  · {t("openIssues", { count: openIssues })}
                </span>
              ) : null}
            </div>
          </div>
          {canCreate ? (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              render={<Link href={`/${project.key}/environments/new`} />}
            >
              <Plus className="size-4" />
              <span className="hidden sm:inline">{t("newEnvironment")}</span>
            </Button>
          ) : null}
        </div>

        {environments.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">
            {t("noEnvironments")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {environments.map((env) => (
              <li key={env.id}>
                <EnvironmentRow
                  env={env}
                  projectKey={project.key}
                  projectName={project.name}
                  activity={lastActivity[env.id] ?? null}
                  dateFnsLocale={dateFnsLocale}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EnvironmentRow({
  env,
  projectKey,
  projectName,
  activity,
  dateFnsLocale,
}: {
  env: EnvironmentSummary;
  projectKey: string;
  projectName: string;
  activity: EnvironmentActivity | null;
  dateFnsLocale: ReturnType<typeof getDateFnsLocale>;
}) {
  const t = useTranslations("home");
  const tDash = useTranslations("dashboard");
  const tKinds = useTranslations("environmentKinds");

  return (
    <Link
      href={`/${projectKey}/${env.slug}`}
      className="group flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <StatusDot status={activity?.status ?? null} />
      <span className="flex flex-col min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-sm truncate">
            {stripProjectPrefix(env.name, projectName)}
          </span>
          {env.kind ? (
            <Badge variant="outline" className="text-[10px] uppercase shrink-0">
              {tKinds(env.kind)}
            </Badge>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
          {env.dbType ? (
            <span className="shrink-0">{tDash(`dbTypes.${env.dbType}`)}</span>
          ) : null}
          {env.dbName ? (
            <code className="font-mono truncate">{env.dbName}</code>
          ) : null}
          {env.owner ? (
            <span className="truncate hidden sm:inline">
              · {t("ownedBy", { owner: env.owner })}
            </span>
          ) : null}
        </span>
      </span>
      <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
        {activity
          ? formatDistanceToNow(new Date(activity.runAt), {
              addSuffix: true,
              locale: dateFnsLocale,
            })
          : t("neverActive")}
      </span>
      <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

// Drop the redundant project-name prefix now that the row sits inside that
// project's card (e.g. "CAR Membership P2SK (137)" -> "P2SK (137)").
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

function StatusDot({
  status,
}: {
  status: EnvironmentActivity["status"] | null;
}) {
  if (status === "started") {
    return <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />;
  }
  if (status === "failed") {
    return <CircleAlert className="size-3.5 text-destructive shrink-0" />;
  }
  if (status === "success") {
    return <CheckCircle2 className="size-3.5 text-success shrink-0" />;
  }
  return (
    <span className="size-3.5 shrink-0 flex items-center justify-center">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
    </span>
  );
}
