"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { EnvironmentSwitcher } from "@/components/nav/environment-switcher";
import { ProjectSwitcher } from "@/components/nav/project-switcher";
import { Separator } from "@/components/ui/separator";
import { useViewTransitionRouter } from "@/hooks/use-view-transition-router";
import { Link, usePathname } from "@/i18n/navigation";
import type { EnvironmentListItem } from "@/lib/db/schema";
import {
  environmentSwitchHref,
  environmentsOf,
  type NavPath,
  type NavProject,
  parseNavPath,
  projectSwitchHref,
} from "@/lib/nav-path";
import {
  canCreateEnvironment,
  canOrg,
  type OrgRole,
  type ProjectRole,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

type StaticSegment = {
  kind: "static";
  href?: string;
  // Either an i18n key or, for data-driven crumbs, the literal label to render.
  labelKey?: string;
  label?: string;
};

// Section landing pages that share a parent with deeper routes. Top-level
// list pages (e.g. /servers, /users, /account) intentionally show no crumb —
// the sidebar already highlights them and the in-page PageHeader carries the
// title. We only add crumbs where they reveal context the user can't see
// elsewhere (a sub-page name, or a deep route outside an environment).
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
  // /admin/jira/new
  if (pathname === "/admin/jira/new") {
    return [
      { kind: "static", href: "/admin/jira", labelKey: "breadcrumbs.jira" },
      { kind: "static", labelKey: "breadcrumbs.new" },
    ];
  }
  // /admin/jira/[id] — edit view
  if (pathname.startsWith("/admin/jira/")) {
    return [
      { kind: "static", href: "/admin/jira", labelKey: "breadcrumbs.jira" },
      { kind: "static", labelKey: "breadcrumbs.edit" },
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

// Map the environment sub-route slug onto an i18n key in the `breadcrumbs`
// namespace. Returning null means we render only the environment switcher (the
// environment dashboard itself — no extra crumb needed since the environment
// name already anchors the location).
function getEnvironmentSubKey(slug: string | undefined): string | null {
  switch (slug) {
    case "services":
      return "breadcrumbs.services";
    case "databases":
      return "breadcrumbs.databases";
    case "backup-restore":
      return "breadcrumbs.backupRestore";
    case "mock-time":
      return "breadcrumbs.mockTime";
    case "mail":
      return "breadcrumbs.mail";
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

// Crumbs after the switchers: the environment section (or Services / Logs), or
// the project-level page's own name.
function getTrailingSegments(
  nav: NavPath,
  activeEnv: EnvironmentListItem | null
): StaticSegment[] {
  if (nav.scope === "env" && activeEnv) {
    if (nav.logs) {
      // Services is a real landing page, so make it a link; Logs is current.
      return [
        {
          kind: "static",
          href: `/${activeEnv.key}/${activeEnv.slug}/services`,
          labelKey: "breadcrumbs.services",
        },
        { kind: "static", labelKey: "breadcrumbs.logs" },
      ];
    }
    const subKey = getEnvironmentSubKey(nav.section ?? undefined);
    return subKey ? [{ kind: "static", labelKey: subKey }] : [];
  }
  if (nav.scope === "project") {
    switch (nav.page) {
      case "settings":
        return [{ kind: "static", labelKey: "breadcrumbs.settings" }];
      case "issue":
        return [{ kind: "static", labelKey: "breadcrumbs.issues" }];
      case "new-environment":
        return [{ kind: "static", labelKey: "breadcrumbs.newEnvironment" }];
      default:
        return [];
    }
  }
  return [];
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
  environments,
  projects,
  orgRole,
  projectRoles,
}: {
  environments: EnvironmentListItem[];
  projects: readonly NavProject[];
  orgRole: OrgRole;
  projectRoles: Record<string, ProjectRole>;
}) {
  const pathname = usePathname();
  const t = useTranslations();
  // View Transitions give a switch a perceptible crossfade so it doesn't look
  // like an instant context wipe.
  const router = useViewTransitionRouter();

  const nav = parseNavPath(pathname);
  // An unknown key (stale bookmark, revoked access) resolves to no project: the
  // page itself 404s, the header just falls back to static crumbs.
  const activeProject =
    nav.scope === null
      ? null
      : (projects.find((p) => p.key === nav.projectKey) ?? null);
  const projectEnvs = React.useMemo(
    () => (activeProject ? environmentsOf(environments, activeProject.id) : []),
    [environments, activeProject]
  );
  const activeEnv =
    nav.scope === "env"
      ? (projectEnvs.find((e) => e.slug === nav.envSlug) ?? null)
      : null;

  // Environments opened since the shell loaded. The root layout doesn't
  // re-render on client navigation, so `lastAccessedAt` alone would send a
  // project switch to whatever was most recent at the last hard load.
  const [visitedAt, setVisitedAt] = React.useState<Record<string, number>>({});
  const activeEnvId = activeEnv?.id;
  React.useEffect(() => {
    if (activeEnvId) {
      setVisitedAt((prev) => ({ ...prev, [activeEnvId]: Date.now() }));
    }
  }, [activeEnvId]);

  function go(href: string) {
    if (href !== pathname) router.push(href);
  }

  if (!activeProject) {
    const segments = getStaticSegments(pathname);
    if (segments.length === 0) return null;
    return (
      <Crumbs>
        {segments.map((seg, i) => (
          <React.Fragment key={`${seg.labelKey ?? seg.label}-${i}`}>
            {i > 0 && <Slash />}
            <StaticCrumb
              href={seg.href}
              label={seg.label ?? t(seg.labelKey as never)}
              isLast={i === segments.length - 1}
            />
          </React.Fragment>
        ))}
      </Crumbs>
    );
  }

  const role = projectRoles[activeProject.id] ?? null;
  const trailing = getTrailingSegments(nav, activeEnv);

  return (
    <Crumbs>
      <ProjectSwitcher
        projects={projects}
        activeProject={activeProject}
        canCreateProject={canOrg(orgRole, { project: ["create"] })}
        onSelect={(project) =>
          go(
            projectSwitchHref({
              projectKey: project.key,
              environments: environments.filter(
                (e) => e.projectId === project.id
              ),
              role: projectRoles[project.id] ?? null,
              from: nav,
              visitedAt,
            })
          )
        }
      />
      <Slash />
      <EnvironmentSwitcher
        environments={projectEnvs}
        activeEnvironment={activeEnv}
        projectName={activeProject.name}
        createHref={
          canCreateEnvironment(orgRole, role)
            ? `/${activeProject.key}/environments/new`
            : null
        }
        onSelect={(env) => go(environmentSwitchHref(env, nav, role))}
      />
      {trailing.map((seg, i) => (
        <React.Fragment key={`${seg.labelKey ?? seg.label}-${i}`}>
          <Slash />
          <StaticCrumb
            href={seg.href}
            label={seg.label ?? t(seg.labelKey as never)}
            isLast={i === trailing.length - 1}
          />
        </React.Fragment>
      ))}
    </Crumbs>
  );
}

function Crumbs({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Separator
        orientation="vertical"
        className="h-5 data-vertical:self-center"
      />
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
        {children}
      </nav>
    </>
  );
}
