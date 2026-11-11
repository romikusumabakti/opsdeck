import * as React from "react";
import { useTranslations } from "use-intl";
import { EnvironmentSwitcher } from "@/components/nav/environment-switcher";
import { ProjectSwitcher } from "@/components/nav/project-switcher";
import { Separator } from "@/components/ui/separator";
import { useViewTransitionRouter } from "@/hooks/use-view-transition-router";
import { Link, usePathname } from "@/i18n/navigation";
import {
  environmentSwitchHref,
  environmentsOf,
  isProjectReleasable,
  type NavPath,
  type NavProject,
  parseNavPath,
  projectSwitchHref,
} from "@/lib/nav-path";
import {
  canCreateProject,
  canProject,
  type OrgRole,
  type ProjectRole,
  SETUP_PERMISSIONS,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { EnvironmentListItem } from "@/web/api/environments";

export type StaticSegment = {
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
  // /admin/repositories/[appKey]/variables — the app's variable templates.
  const appVariables = /^\/admin\/repositories\/([^/]+)\/variables$/.exec(
    pathname
  );
  if (appVariables?.[1]) {
    return [
      {
        kind: "static",
        href: "/admin/repositories",
        labelKey: "breadcrumbs.repositories",
      },
      {
        kind: "static",
        href: `/admin/repositories/${appVariables[1]}`,
        label: appVariables[1],
      },
      { kind: "static", labelKey: "breadcrumbs.variables" },
    ];
  }
  // /admin/repositories/[appKey] — the app's page; the key is the crumb.
  if (pathname.startsWith("/admin/repositories/")) {
    return [
      {
        kind: "static",
        href: "/admin/repositories",
        labelKey: "breadcrumbs.repositories",
      },
      {
        kind: "static",
        label: pathname.slice("/admin/repositories/".length),
      },
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
    case "deploys":
      return "breadcrumbs.deploys";
    case "variables":
      return "breadcrumbs.variables";
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
    default:
      return null;
  }
}

// Crumbs after the switchers: the environment section (or Services / Logs), or
// the project-level page's own name.
export function getTrailingSegments(
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
      case "issues":
        return [{ kind: "static", labelKey: "breadcrumbs.issues" }];
      case "issue":
        return [
          {
            kind: "static",
            href: `/${nav.projectKey}/issues`,
            labelKey: "breadcrumbs.issues",
          },
          { kind: "static", label: `${nav.projectKey}-${nav.issueNumber}` },
        ];
      case "milestones":
        return [{ kind: "static", labelKey: "breadcrumbs.milestones" }];
      case "members":
        return [{ kind: "static", labelKey: "breadcrumbs.members" }];
      case "settings":
        return [{ kind: "static", labelKey: "breadcrumbs.settings" }];
      case "releases":
        return [{ kind: "static", labelKey: "breadcrumbs.releases" }];
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
      className="shrink-0 text-muted-foreground/50 text-base font-light select-none"
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
  // shrink-0: static crumbs are short (the current page); the switchers give
  // way first when the header runs out of room.
  const base =
    "shrink-0 text-sm font-medium px-2 h-8 inline-flex items-center rounded-md";
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
        canCreateProject={canCreateProject(
          orgRole,
          Object.values(projectRoles)
        )}
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
              releasable: isProjectReleasable(environments, project.id),
            })
          )
        }
      />
      {nav.scope === "env" && (
        <>
          <Slash />
          <EnvironmentSwitcher
            environments={projectEnvs}
            activeEnvironment={activeEnv}
            projectName={activeProject.name}
            createHref={
              canProject(role, SETUP_PERMISSIONS)
                ? `/${activeProject.key}/environments/new`
                : null
            }
            onSelect={(env) => go(environmentSwitchHref(env, nav, role))}
          />
        </>
      )}
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
