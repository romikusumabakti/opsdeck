"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
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
import { Link, usePathname } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const PROJECT_PATH_REGEX = /^\/projects\/([0-9a-f-]{20,})(?:\/([^/?#]+))?/i;
// Logs live one level below services (/services/<role>/logs) — the single-slug
// project regex can't see that depth, so match it explicitly to render a
// Services › Logs trail instead of stopping at Services.
const LOGS_PATH_REGEX =
  /^\/projects\/[0-9a-f-]{20,}\/services\/(?:db|backend|frontend)\/logs/i;

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
      { kind: "static", href: "/", labelKey: "breadcrumbs.projects" },
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
// because the intent is "show me area X for another project". Flow/action
// routes (backup-restore, mock-time) are deliberately
// excluded: they're tied to the source project's context and often mid-
// operation, so we drop those switches back to the target dashboard.
const PARALLEL_SECTIONS = new Set([
  "services",
  "databases",
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
  isAdmin,
}: {
  projects: Project[];
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations();

  const match = PROJECT_PATH_REGEX.exec(pathname);
  const activeProjectId = match?.[1];
  const projectSubSlug = match?.[2];
  const activeProject = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId) ?? null)
    : null;

  // Build the trailing segment list (after the optional project switcher).
  let trailing: StaticSegment[] = [];
  if (activeProject) {
    if (LOGS_PATH_REGEX.test(pathname)) {
      // Services is a real landing page, so make it a link; Logs is current.
      trailing = [
        {
          kind: "static",
          href: `/projects/${activeProjectId}/services`,
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
      <Separator orientation="vertical" className="h-5" />
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
        {activeProject ? (
          <ProjectSwitcher
            projects={projects}
            activeProject={activeProject}
            isAdmin={isAdmin}
            activeSection={
              projectSubSlug && PARALLEL_SECTIONS.has(projectSubSlug)
                ? projectSubSlug
                : undefined
            }
          />
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
  activeProject,
  isAdmin,
  activeSection,
}: {
  projects: Project[];
  activeProject: Project;
  isAdmin: boolean;
  activeSection?: string;
}) {
  // View Transitions API gives the project switch a perceptible crossfade so
  // it doesn't look like an instant context wipe; helps locate which content
  // changed when many sections re-render at once.
  const router = useViewTransitionRouter();
  const tHeader = useTranslations("header");
  const [open, setOpen] = React.useState(false);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="gap-1.5 h-8 px-2 font-medium"
        >
          <span className="truncate max-w-[140px] sm:max-w-[240px]">
            {activeProject.name}
          </span>
          <ChevronDown className="size-3.5 opacity-60 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={tHeader("searchProject")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>{tHeader("noProject")}</CommandEmpty>
            {projects.length > 0 && (
              <CommandGroup>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.name}
                    onSelect={() =>
                      go(
                        activeSection
                          ? `/projects/${project.id}/${activeSection}`
                          : `/projects/${project.id}`
                      )
                    }
                  >
                    <span className="size-5 rounded bg-primary/10 text-primary flex items-center justify-center text-[10px] font-semibold shrink-0">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate">{project.name}</span>
                    <Check
                      className={cn(
                        "ms-auto size-4 shrink-0",
                        activeProject.id === project.id
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {isAdmin && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__create-project"
                    onSelect={() => go("/projects/new")}
                  >
                    <Plus className="size-4" />
                    {tHeader("createProject")}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
