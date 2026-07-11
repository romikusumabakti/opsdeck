"use client";

import { Check, ChevronDown, FolderPlus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useViewTransitionRouter } from "@/hooks/use-view-transition-router";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import type { EnvironmentListItem } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

// Drop the redundant project-name prefix from an environment's name when it's
// shown under that project's heading (e.g. "CAR Membership P2SK (137)" ->
// "P2SK (137)"). Falls back to the full name when there's nothing left.
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

// Readable env path: /[KEY]/[envSlug]/[sub?]. group1=key, group2=envSlug,
// group3=section slug. Uppercase key distinguishes it from lowercase top-level
// routes.
const ENV_PATH_REGEX =
  /^\/([A-Z][A-Z0-9]{1,9})\/([a-z0-9][a-z0-9-]*)(?:\/([^/?#]+))?/;
// Logs live one level below services (/[key]/[slug]/services/<role>/logs).
const LOGS_PATH_REGEX =
  /^\/[A-Z][A-Z0-9]{1,9}\/[a-z0-9-]+\/services\/(?:db|backend|frontend)\/logs/;

type StaticSegment = {
  kind: "static";
  href?: string;
  labelKey: string;
};

// Section landing pages that share a parent with deeper routes. Top-level
// list pages (e.g. /servers, /users, /account) intentionally show no crumb —
// the sidebar already highlights them and the in-page PageHeader carries the
// title. We only add crumbs where they reveal context the user can't see
// elsewhere (a sub-page name, or a non-project deep route).
function getStaticSegments(pathname: string): StaticSegment[] {
  // /servers/new
  if (pathname === "/servers/new") {
    return [
      { kind: "static", href: "/servers", labelKey: "breadcrumbs.servers" },
      { kind: "static", labelKey: "breadcrumbs.new" },
    ];
  }
  // /servers/[id] — edit view
  if (pathname.startsWith("/servers/")) {
    return [
      { kind: "static", href: "/servers", labelKey: "breadcrumbs.servers" },
      { kind: "static", labelKey: "breadcrumbs.edit" },
    ];
  }
  // /projects/new
  if (pathname === "/projects/new") {
    return [
      { kind: "static", href: "/projects", labelKey: "breadcrumbs.projects" },
      { kind: "static", labelKey: "breadcrumbs.new" },
    ];
  }
  // /account/change-password
  if (pathname === "/account/change-password") {
    return [
      { kind: "static", href: "/account", labelKey: "breadcrumbs.account" },
      { kind: "static", labelKey: "breadcrumbs.changePassword" },
    ];
  }
  return [];
}

// Sections that exist identically under every project. When the user
// switches projects from one of these, we keep them on the same section in
// the target project (e.g. /projects/A/services → /projects/B/services)
// because the intent is "show me area X for another project". backup-restore
// is deliberately excluded: it's a source-specific flow, often mid-operation,
// so switching from there drops back to the target dashboard.
const PARALLEL_SECTIONS = new Set([
  "services",
  "databases",
  "mock-time",
  "issues",
  "history",
  "settings",
]);

// Map the project sub-route slug onto an i18n key in the `breadcrumbs`
// namespace. Returning null means we render only the project switcher (the
// project dashboard itself — no extra crumb needed since the project name
// already anchors the location).
function getProjectSubKey(slug: string | undefined): string | null {
  switch (slug) {
    case "services":
      return "breadcrumbs.services";
    case "databases":
      return "breadcrumbs.databases";
    case "backup-restore":
      return "breadcrumbs.backupRestore";
    case "mock-time":
      return "breadcrumbs.mockTime";
    case "history":
      return "breadcrumbs.history";
    case "settings":
      return "breadcrumbs.settings";
    case "issues":
      return "breadcrumbs.issues";
    default:
      return null;
  }
}

function Slash() {
  return (
    <span
      className="text-muted-foreground/50 text-base font-light select-none"
      aria-hidden="true"
    >
      /
    </span>
  );
}

function StaticCrumb({
  href,
  label,
  isLast,
}: {
  href?: string;
  label: string;
  isLast: boolean;
}) {
  const base =
    "text-sm font-medium px-2 h-8 inline-flex items-center rounded-md";
  if (href && !isLast) {
    return (
      <Link
        href={href}
        className={cn(
          base,
          "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        )}
      >
        {label}
      </Link>
    );
  }
  return (
    <span
      className={cn(base, isLast ? "text-foreground" : "text-muted-foreground")}
      aria-current={isLast ? "page" : undefined}
    >
      {label}
    </span>
  );
}

export function HeaderBreadcrumb({
  projects,
  projectNameById,
  projectKeyById,
  isAdmin,
}: {
  projects: EnvironmentListItem[];
  projectNameById: Record<string, string>;
  projectKeyById: Record<string, string>;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations();

  const match = ENV_PATH_REGEX.exec(pathname);
  const projectSubSlug = match?.[3];
  const activeProject = match
    ? (projects.find((p) => p.key === match[1] && p.slug === match[2]) ?? null)
    : null;

  // Build the trailing segment list (after the optional project switcher).
  let trailing: StaticSegment[] = [];
  if (activeProject) {
    if (LOGS_PATH_REGEX.test(pathname)) {
      // Services is a real landing page, so make it a link; Logs is current.
      trailing = [
        {
          kind: "static",
          href: `/${activeProject.key}/${activeProject.slug}/services`,
          labelKey: "breadcrumbs.services",
        },
        { kind: "static", labelKey: "breadcrumbs.logs" },
      ];
    } else {
      const subKey = getProjectSubKey(projectSubSlug);
      if (subKey) {
        trailing = [{ kind: "static", labelKey: subKey }];
      }
    }
  } else {
    trailing = getStaticSegments(pathname);
  }

  const hasContent = activeProject !== null || trailing.length > 0;
  if (!hasContent) {
    return null;
  }

  return (
    <>
      <Separator
        orientation="vertical"
        className="h-5 data-vertical:self-center"
      />
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
        {activeProject ? (
          <>
            <StaticCrumb
              href={`/project/${projectKeyById[activeProject.projectId] ?? ""}`}
              label={projectNameById[activeProject.projectId] ?? "—"}
              isLast={false}
            />
            <Slash />
            <ProjectSwitcher
              projects={projects}
              projectNameById={projectNameById}
              activeProject={activeProject}
              isAdmin={isAdmin}
              activeSection={
                projectSubSlug && PARALLEL_SECTIONS.has(projectSubSlug)
                  ? projectSubSlug
                  : undefined
              }
            />
          </>
        ) : null}
        {trailing.map((seg, i) => {
          const isLast = i === trailing.length - 1;
          return (
            <React.Fragment key={`${seg.labelKey}-${i}`}>
              {(activeProject || i > 0) && <Slash />}
              <StaticCrumb
                href={seg.href}
                label={t(seg.labelKey as never)}
                isLast={isLast}
              />
            </React.Fragment>
          );
        })}
      </nav>
    </>
  );
}

function ProjectSwitcher({
  projects,
  projectNameById,
  activeProject,
  isAdmin,
  activeSection,
}: {
  projects: EnvironmentListItem[];
  projectNameById: Record<string, string>;
  activeProject: EnvironmentListItem;
  isAdmin: boolean;
  activeSection?: string;
}) {
  // View Transitions API gives the project switch a perceptible crossfade so
  // it doesn't look like an instant context wipe; helps locate which content
  // changed when many sections re-render at once.
  const router = useViewTransitionRouter();
  const plainRouter = useRouter();
  const tHeader = useTranslations("header");
  const tKinds = useTranslations("environmentKinds");
  const [open, setOpen] = React.useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);

  const activeProjectName = projectNameById[activeProject.projectId] ?? "";

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  // Group the flat environment list under their logical project, then sort the
  // groups alphabetically by project name so the switcher mirrors the
  // two-level model.
  const groups = React.useMemo(() => {
    const byProject = new Map<string, EnvironmentListItem[]>();
    for (const env of projects) {
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
        heading: projectNameById[projectId] ?? "—",
        envs,
      }))
      .sort((a, b) => a.heading.localeCompare(b.heading));
  }, [projects, projectNameById]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="gap-1.5 h-8 px-2 font-medium"
          />
        }
      >
        <span className="flex items-center gap-1 min-w-0 max-w-[180px] sm:max-w-[300px]">
          <span className="truncate">
            {stripProjectPrefix(activeProject.name, activeProjectName)}
          </span>
        </span>
        <ChevronDown className="size-3.5 opacity-60 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={tHeader("searchProject")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>{tHeader("noProject")}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.projectId} heading={group.heading}>
                {group.envs.map((env) => (
                  <CommandItem
                    key={env.id}
                    // Include the project name so search matches the heading too.
                    value={`${group.heading} ${env.name}`}
                    onSelect={() =>
                      go(
                        activeSection
                          ? `/${env.key}/${env.slug}/${activeSection}`
                          : `/${env.key}/${env.slug}`
                      )
                    }
                  >
                    <span className="flex-1 min-w-0 truncate">
                      {stripProjectPrefix(env.name, group.heading)}
                    </span>
                    {env.kind ? (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        {tKinds(env.kind)}
                      </span>
                    ) : null}
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        activeProject.id === env.id
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {isAdmin && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__create-environment"
                    onSelect={() => go("/projects/new")}
                  >
                    <Plus className="size-4" />
                    {tHeader("createEnvironment")}
                  </CommandItem>
                  <CommandItem
                    value="__create-project"
                    onSelect={() => {
                      setOpen(false);
                      setProjectDialogOpen(true);
                    }}
                  >
                    <FolderPlus className="size-4" />
                    {tHeader("createProject")}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>

      <ProjectCreateDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        onCreated={() => {
          setProjectDialogOpen(false);
          plainRouter.refresh();
        }}
      />
    </Popover>
  );
}
