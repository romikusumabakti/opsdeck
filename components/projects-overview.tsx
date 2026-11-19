import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Loader2,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { EnvironmentHost } from "@/components/nav/environment-host";
import { EnvironmentOwner } from "@/components/nav/environment-owner";
import { EnvironmentUrlButton } from "@/components/nav/environment-url";
import { RelativeTime, useRelativeTimeText } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FacetedFilter } from "@/components/ui/faceted-filter";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipHint,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import type { EnvironmentSummaryWithOwner } from "@/lib/db/schema";
import { compareEnvironments, stripProjectPrefix } from "@/lib/nav-path";
import {
  canProject,
  type ProjectRole,
  SETUP_PERMISSIONS,
} from "@/lib/permissions";
import type { ProjectWithEnvironments } from "@/web/api/project-catalog";
import type { ProjectGroupSummary } from "@/web/api/project-groups";
import type { EnvironmentActivity } from "@/web/api/runs";

export type SortKey = "recent" | "opened" | "name_asc" | "name_desc";

// Filter and collapse key of the projects that belong to no group. Group ids
// are UUIDs, so it cannot collide.
const NO_GROUP = "none";

const collapsedKey = (userId: string) =>
  `menara:projects:collapsed-groups:${userId}`;

function readCollapsed(userId: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(collapsedKey(userId)) ?? "[]");
    return new Set(
      Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []
    );
  } catch {
    return new Set();
  }
}

export function ProjectsOverview({
  projects,
  openIssueCounts,
  lastActivity,
  lastOpened,
  initialSort,
  projectRoles,
  groups,
  userId,
}: {
  projects: ProjectWithEnvironments[];
  openIssueCounts: Record<string, number>;
  lastActivity: Record<string, EnvironmentActivity | null>;
  lastOpened: Record<string, number>;
  initialSort: SortKey;
  projectRoles: Record<string, ProjectRole>;
  /** Every group, in rank order. */
  groups: ProjectGroupSummary[];
  /** Keys the collapsed sections the user left closed in this browser. */
  userId: string;
}) {
  const t = useTranslations("home");
  const router = useRouter();
  const pathname = usePathname();

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>(initialSort);
  const [groupFilter, setGroupFilter] = React.useState<string[]>([]);
  const [collapsed, setCollapsed] = React.useState(() => readCollapsed(userId));

  const groupName = React.useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups]
  );

  // Sections only help when there is something to tell apart: with at most
  // one group in use the page stays the plain grid. Decided on every project,
  // so searching or filtering never flips the layout.
  const groupsInUse = React.useMemo(
    () => groups.filter((g) => projects.some((p) => p.groupId === g.id)),
    [groups, projects]
  );
  const sectioned = groupsInUse.length > 1;

  function toggleSection(id: string) {
    // A search forces every section open, so a toggle would only change what
    // is saved for after it.
    if (query.trim() !== "") return;
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(collapsedKey(userId), JSON.stringify([...next]));
    } catch {
      // Private mode or a full quota: the section still toggles for now.
    }
  }

  // Persist the sort in the URL (?sort=) so it survives reload, back/forward,
  // and is shareable. `recent` is the default, so keep it out of the URL to
  // leave the canonical /projects link clean.
  function changeSort(next: SortKey) {
    setSort(next);
    router.replace(next === "recent" ? pathname : `${pathname}?sort=${next}`);
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

  // Search spans both levels: a project matches on its own name/key/group (and
  // keeps all its environments), otherwise it survives only through the
  // environments whose name or database matches — so typing "qa" narrows each
  // project down to its QA deployment instead of hiding the project entirely.
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered: ProjectWithEnvironments[] = [];
    for (const p of projects) {
      if (
        sectioned &&
        groupFilter.length > 0 &&
        !groupFilter.includes(p.groupId ?? NO_GROUP)
      ) {
        continue;
      }
      if (!q) {
        filtered.push(p);
        continue;
      }
      const projectHit =
        p.name.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (groupName.get(p.groupId ?? "") ?? "").toLowerCase().includes(q);
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
  }, [
    projects,
    query,
    sort,
    activityOf,
    openedOf,
    groupName,
    groupFilter,
    sectioned,
  ]);

  const sections = React.useMemo(() => {
    if (!sectioned) return [];
    const byGroup = new Map<string, ProjectWithEnvironments[]>();
    for (const p of visible) {
      const id = p.groupId ?? NO_GROUP;
      const list = byGroup.get(id);
      if (list) list.push(p);
      else byGroup.set(id, [p]);
    }
    return [
      ...groups.map((g) => ({ id: g.id, name: g.name })),
      { id: NO_GROUP, name: t("noGroup") },
    ]
      .map((section) => ({
        ...section,
        projects: byGroup.get(section.id) ?? [],
      }))
      .filter((section) => section.projects.length > 0);
  }, [sectioned, visible, groups, t]);

  const groupOptions = React.useMemo(() => {
    const count = (id: string) =>
      projects.filter((p) => (p.groupId ?? NO_GROUP) === id).length;
    return [
      ...groupsInUse.map((g) => ({
        value: g.id,
        label: g.name,
        count: count(g.id),
      })),
      ...(count(NO_GROUP) > 0
        ? [{ value: NO_GROUP, label: t("noGroup"), count: count(NO_GROUP) }]
        : []),
    ];
  }, [projects, groupsInUse, t]);

  const renderCards = (list: ProjectWithEnvironments[]) => (
    <div className="grid grid-cols-1 xl:grid-cols-2 items-start gap-4">
      {list.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          openIssues={openIssueCounts[project.id] ?? 0}
          lastActivity={lastActivity}
          role={projectRoles[project.id] ?? null}
          groupLabel={
            sectioned ? null : (groupName.get(project.groupId ?? "") ?? null)
          }
        />
      ))}
    </div>
  );

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
        {sectioned && (
          <FacetedFilter
            title={t("groupFilter")}
            options={groupOptions}
            selected={groupFilter}
            onChange={setGroupFilter}
          />
        )}
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
            {query.trim()
              ? t("noMatch", { query: query.trim() })
              : t("noMatchGroups")}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setQuery("");
              setGroupFilter([]);
            }}
          >
            {query.trim() ? t("clearSearch") : t("clearFilters")}
          </Button>
        </div>
      ) : sectioned ? (
        <div className="flex flex-col gap-6">
          {sections.map((section) => {
            // A search shows every match, whatever the user collapsed.
            const open = query.trim() !== "" || !collapsed.has(section.id);
            return (
              <section key={section.id} className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleSection(section.id)}
                    className="flex items-center gap-2 rounded-md text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {open ? (
                      <ChevronDown className="size-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" />
                    )}
                    <span>{section.name}</span>
                    <Badge variant="secondary" className="tabular-nums">
                      {section.projects.length}
                    </Badge>
                  </button>
                </h2>
                {open && renderCards(section.projects)}
              </section>
            );
          })}
        </div>
      ) : (
        renderCards(visible)
      )}
    </div>
  );
}

function ProjectCard({
  project,
  openIssues,
  lastActivity,
  role,
  groupLabel,
}: {
  project: ProjectWithEnvironments;
  openIssues: number;
  lastActivity: Record<string, EnvironmentActivity | null>;
  role: ProjectRole | null;
  /** The group name, shown only where no section header already names it. */
  groupLabel: string | null;
}) {
  const canCreateEnvironment = canProject(role, SETUP_PERMISSIONS);
  const canUpdateEnvironment = canProject(role, { environment: ["update"] });
  const t = useTranslations("home");
  const tOv = useTranslations("projectOverview");
  const environments = [...project.environments].sort(compareEnvironments);

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
              <Badge variant="secondary" className="font-mono text-sm shrink-0">
                {project.key}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
              <span className="shrink-0">
                {t("environmentCount", { count: project.environments.length })}
              </span>
              {openIssues > 0 ? (
                <span className="shrink-0">
                  · {t("openIssues", { count: openIssues })}
                </span>
              ) : null}
              {groupLabel ? (
                <span className="truncate">· {groupLabel}</span>
              ) : null}
            </div>
          </div>
          {canCreateEnvironment || canUpdateEnvironment ? (
            <div className="flex shrink-0 items-center gap-1">
              {canCreateEnvironment && (
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={`/${project.key}/environments/new`} />}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">
                    {t("newEnvironment")}
                  </span>
                </Button>
              )}
              {canUpdateEnvironment && (
                <TooltipHint label={tOv("editProject")}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tOv("editProject")}
                    nativeButton={false}
                    render={<Link href={`/${project.key}/settings`} />}
                  >
                    <Settings className="size-4" />
                  </Button>
                </TooltipHint>
              )}
            </div>
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
}: {
  env: EnvironmentSummaryWithOwner;
  projectKey: string;
  projectName: string;
  activity: EnvironmentActivity | null;
}) {
  const t = useTranslations("home");
  const tDash = useTranslations("dashboard");
  const tKinds = useTranslations("environmentKinds");

  // The name link stretches over the whole row (after:inset-0), so the row is
  // one click target; the URL button and the status dot sit above it (z-10)
  // and keep their own click and hover.
  return (
    <div className="group relative flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors">
      <StatusDot activity={activity ?? null} />
      <span className="flex flex-col min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-2 min-w-0">
          <Link
            href={`/${projectKey}/${env.slug}`}
            className="text-sm truncate after:absolute after:inset-0 focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {stripProjectPrefix(env.name, projectName)}
          </Link>
          <EnvironmentUrlButton url={env.url} className="relative z-10" />
          <EnvironmentHost url={env.url} className="max-w-[40%]" />
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
            <span className="hidden min-w-0 items-center gap-1 sm:flex">
              <span aria-hidden>·</span>
              <EnvironmentOwner owner={env.owner} />
            </span>
          ) : null}
        </span>
      </span>
      <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
        {activity ? <RelativeTime date={activity.runAt} /> : t("neverActive")}
      </span>
      <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
    </div>
  );
}

function StatusDot({ activity }: { activity: EnvironmentActivity | null }) {
  const t = useTranslations("home");
  const relativeText = useRelativeTimeText();
  const status = activity?.status ?? null;

  let icon: React.ReactNode;
  let label: string | null = null;
  if (activity && status === "started") {
    icon = <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />;
    label = t("statusRunning");
  } else if (activity && status === "failed") {
    icon = <CircleAlert className="size-3.5 text-destructive shrink-0" />;
    label = t("statusFailed", { relative: relativeText(activity.runAt) });
  } else if (activity && status === "success") {
    icon = <CheckCircle2 className="size-3.5 text-success shrink-0" />;
    label = t("statusSucceeded", { relative: relativeText(activity.runAt) });
  } else {
    icon = (
      <span className="size-3.5 shrink-0 flex items-center justify-center">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      </span>
    );
  }
  // No run yet: nothing to explain, so no tooltip.
  if (!label) return icon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="relative z-10 shrink-0 flex"
          >
            {icon}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
