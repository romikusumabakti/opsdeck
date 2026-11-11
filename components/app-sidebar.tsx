import {
  Activity,
  BookOpen,
  Boxes,
  Cable,
  CircleDot,
  Clock,
  CloudCog,
  Cog,
  DatabaseZap,
  Flag,
  FolderKanban,
  HardDrive,
  History,
  House,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Mail,
  PackageCheck,
  Rocket,
  Server,
  ServerCog,
  Settings,
  ShieldUser,
  Users,
  UsersRound,
  Workflow,
} from "lucide-react";
import { useTranslations } from "use-intl";
import {
  useActiveRunCount,
  useActiveRuns,
} from "@/components/active-runs-provider";
import { BrandLogo } from "@/components/brand-mark";
import { useMotif } from "@/components/motif-provider";
import { MotifWatermark } from "@/components/motif-watermark";
import { SidebarCountBadge } from "@/components/sidebar-count-badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { UserMenu, type UserSummary } from "@/components/user-menu";
import { Link, usePathname } from "@/i18n/navigation";
import type { BrandName } from "@/lib/brands";
import { type EnvSection, visibleEnvSections } from "@/lib/env-sections";
import {
  isProjectReleasable,
  type NavProject,
  type ProjectNavKey,
  parseNavPath,
  projectNavItems,
  SECTION_PERMS,
  stripProjectPrefix,
} from "@/lib/nav-path";
import {
  canOrg,
  canProject,
  type OrgPermissions,
  type OrgRole,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";
import type { EnvironmentListItem } from "@/web/api/environments";
import type { AssignedIssueCounts } from "@/web/api/issues";

// Sidebar items that exist only when the environment has a matching service.
const SERVICE_SECTION: Partial<Record<string, EnvSection>> = {
  databases: "databases",
  mockTime: "mockTime",
};

type EnvironmentItem = {
  key: string;
  url: string;
  icon: LucideIcon;
  perm?: ProjectPermissions;
};

const PROJECT_ICONS: Record<ProjectNavKey, LucideIcon> = {
  overview: LayoutDashboard,
  issues: CircleDot,
  milestones: Flag,
  releases: PackageCheck,
  members: Users,
  settings: Settings,
};

const environmentItems: EnvironmentItem[] = [
  { key: "dashboard", url: "", icon: LayoutDashboard },
  { key: "services", url: "/services", icon: ServerCog },
  { key: "deploys", url: "/deploys", icon: Rocket },
  {
    key: "variables",
    url: "/variables",
    icon: KeyRound,
    perm: SECTION_PERMS.variables,
  },
  { key: "databases", url: "/databases", icon: DatabaseZap },
  {
    key: "mockTime",
    url: "/mock-time",
    icon: Clock,
    perm: SECTION_PERMS["mock-time"],
  },
  { key: "mail", url: "/mail", icon: Mail, perm: SECTION_PERMS.mail },
  { key: "history", url: "/history", icon: History },
  {
    key: "settings",
    url: "/settings",
    icon: Settings,
    perm: SECTION_PERMS.settings,
  },
];

// Sections of the /admin area, shown as their own sidebar groups while the
// user is inside it: the admin pages, then the integrations under their own
// label. Each page enforces the same permission server-side.
type AdminItem = {
  key: string;
  url: string;
  icon: LucideIcon;
  perm: OrgPermissions;
};

const adminItems: AdminItem[] = [
  {
    key: "activity",
    url: "/admin/activity",
    icon: Activity,
    perm: { audit: ["read"] },
  },
  { key: "users", url: "/admin/users", icon: Users, perm: { user: ["list"] } },
  {
    key: "repositories",
    url: "/admin/repositories",
    icon: Boxes,
    perm: { integration: ["manage"] },
  },
  {
    key: "instance",
    url: "/admin/instance",
    icon: Cog,
    perm: { instance: ["manage"] },
  },
];

const integrationItems: AdminItem[] = [
  {
    key: "jira",
    url: "/admin/jira",
    icon: Cable,
    perm: { integration: ["manage"] },
  },
  {
    key: "ci",
    url: "/admin/ci",
    icon: Workflow,
    perm: { integration: ["manage"] },
  },
  {
    key: "cloudflare",
    url: "/admin/cloudflare",
    icon: CloudCog,
    perm: { server: ["manage"] },
  },
];

/**
 * Tooltip for a row that may carry a count badge. Rows without a count keep
 * the default behaviour (the name, shown only when collapsed to icons); with a
 * count the tooltip also explains the number, and shows in expanded mode too,
 * since the badge itself must stay click-through to the link.
 */
function rowTooltip(name: string, count: number, label: string) {
  if (count <= 0) return name;
  return { children: `${name} · ${label}`, hidden: false };
}

/**
 * The motif in the bottom corner of the sidebar. The sidebar sits at the
 * screen's start edge, so the ornament hugs the bottom-start corner, which is
 * the screen corner. The art's own corner is bottom-right, so it is mirrored in
 * LTR; in RTL the sidebar is on the right and the art needs no mirroring. It
 * reaches the very bottom, behind the user menu, and sits behind the menu items
 * (-z-10 inside an isolated wrapper; a positioned layer would otherwise paint
 * over them). It is hidden when the sidebar collapses to icons. It has the same
 * size as on the sign-in page (MotifWatermark owns it), so it is wider than
 * the sidebar and gets clipped.
 *
 * The mirror sits on a layer exactly the sidebar's size that does its own
 * clipping, not on the oversized ornament: Firefox applied the sidebar's clip
 * to a mirrored, oversized box in its unmirrored coordinates and drew only a
 * strip of it on screen. Mirroring a box that matches the clip maps the clip
 * onto itself, so the result is the same either way.
 */
function SidebarMotif() {
  const { motif } = useMotif();
  if (!motif) return null;
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden -scale-x-100 rtl:scale-x-100 group-data-[collapsible=icon]:hidden">
      <MotifWatermark slug={motif} className="absolute right-0 bottom-0" />
    </div>
  );
}

export function AppSidebar({
  environments,
  projects,
  orgRole,
  projectRoles,
  issueCounts,
  openCounts,
  user,
  logo,
  side = "left",
}: {
  environments: EnvironmentListItem[];
  projects: NavProject[];
  orgRole: OrgRole;
  projectRoles: Record<string, ProjectRole>;
  issueCounts: AssignedIssueCounts;
  openCounts: Record<string, number>;
  user: UserSummary;
  logo: BrandName;
  side?: "left" | "right";
}) {
  const tApp = useTranslations("app");
  const tNav = useTranslations("nav");
  const pathname = usePathname();

  const canSeeServers = canOrg(orgRole, { server: ["read"] });
  const canSeeStorage = canOrg(orgRole, { storage: ["read"] });
  const canSeeAdmin = canOrg(orgRole, { audit: ["read"] });
  const inAdmin =
    canSeeAdmin && (pathname === "/admin" || pathname.startsWith("/admin/"));

  const nav = parseNavPath(pathname);
  const activeEnv =
    nav.scope === "env"
      ? (environments.find(
          (e) => e.key === nav.projectKey && e.slug === nav.envSlug
        ) ?? null)
      : null;

  // The project group belongs to the active environment's project, or to the
  // project named in the URL on a project-level page.
  const activeProject =
    (nav.scope === "env"
      ? projects.find((p) => p.id === activeEnv?.projectId)
      : nav.scope === "project"
        ? projects.find((p) => p.key === nav.projectKey)
        : undefined) ?? null;
  const activeProjectName = activeProject?.name ?? "";
  const projectItems = activeProject
    ? projectNavItems(
        activeProject.key,
        projectRoles[activeProject.id] ?? null,
        isProjectReleasable(environments, activeProject.id)
      )
    : [];

  const envSections = activeEnv
    ? visibleEnvSections({
        services: activeEnv.serviceRoles.map((role) => ({ role })),
      })
    : new Set<EnvSection>();

  const envRole = activeEnv
    ? (projectRoles[activeEnv.projectId] ?? null)
    : null;

  // The project's Issues badge counts every open issue in that project, not
  // just the caller's.
  const projectIssueCount = activeProject
    ? (openCounts[activeProject.id] ?? 0)
    : 0;
  // Live from the shared run stream: the History badge is "something is
  // happening right now", not a stored count.
  const envRunCount = useActiveRunCount(activeEnv?.id ?? null);
  const anyRunActive = useActiveRuns().length > 0;
  const assignedLabel = tNav("badgeAssignedOpen", {
    count: issueCounts.total,
  });

  return (
    <Sidebar collapsible="icon" side={side}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/" />}
              size="lg"
              tooltip={tApp("name")}
            >
              <BrandLogo logo={logo} active={anyRunActive} />
              <span className="font-semibold truncate">{tApp("name")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <div className="relative isolate flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <SidebarMotif />
        {/* The global group is pinned; only the contextual group (admin or
            environment) scrolls, so Home…Admin never leave a short viewport. */}
        <SidebarGroup className="shrink-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/" />}
                  isActive={pathname === "/"}
                  tooltip={tNav("home")}
                >
                  <House />
                  <span>{tNav("home")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/projects" />}
                  isActive={pathname === "/projects"}
                  tooltip={tNav("projects")}
                >
                  <FolderKanban />
                  <span>{tNav("projects")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/issues" />}
                  isActive={pathname.startsWith("/issues")}
                  tooltip={rowTooltip(
                    tNav("allIssues"),
                    issueCounts.total,
                    assignedLabel
                  )}
                >
                  <CircleDot />
                  <span>{tNav("allIssues")}</span>
                </SidebarMenuButton>
                <SidebarCountBadge
                  count={issueCounts.total}
                  label={assignedLabel}
                />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/knowledge" />}
                  isActive={pathname.startsWith("/knowledge")}
                  tooltip={tNav("knowledge")}
                >
                  <BookOpen />
                  <span>{tNav("knowledge")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/people" />}
                  isActive={pathname.startsWith("/people")}
                  tooltip={tNav("people")}
                >
                  <UsersRound />
                  <span>{tNav("people")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {canSeeServers && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/servers" />}
                    isActive={pathname.startsWith("/servers")}
                    tooltip={tNav("servers")}
                  >
                    <Server />
                    <span>{tNav("servers")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {canSeeStorage && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/storage" />}
                    isActive={pathname.startsWith("/storage")}
                    tooltip={tNav("storage")}
                  >
                    <HardDrive />
                    <span>{tNav("storage")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {canSeeAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href="/admin" />}
                    isActive={inAdmin}
                    tooltip={tNav("admin")}
                  >
                    <ShieldUser />
                    <span>{tNav("admin")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarContent>
          {/* The admin sections only appear once you're inside /admin, the same
            way the environment sections appear inside an environment. */}
          {inAdmin &&
            (
              [
                { label: "admin", items: adminItems },
                { label: "integrations", items: integrationItems },
              ] as const
            ).map(({ label, items }) => {
              const visible = items.filter((item) =>
                canOrg(orgRole, item.perm)
              );
              if (visible.length === 0) return null;
              return (
                <SidebarGroup key={label}>
                  <SidebarGroupLabel>{tNav(label)}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {visible.map((item) => (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            render={<Link href={item.url} />}
                            isActive={pathname.startsWith(item.url)}
                            tooltip={tNav(item.key)}
                          >
                            <item.icon />
                            <span>{tNav(item.key)}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              );
            })}

          {activeProject && projectItems.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel
                className="truncate"
                title={activeProject.name}
              >
                {activeProject.name}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {projectItems.map((item) => {
                    const Icon = PROJECT_ICONS[item.key];
                    const isActive =
                      item.key === "overview"
                        ? pathname === item.href
                        : pathname.startsWith(item.href);
                    const badge =
                      item.key === "issues"
                        ? {
                            count: projectIssueCount,
                            label: tNav("badgeProjectOpen", {
                              count: projectIssueCount,
                            }),
                          }
                        : null;
                    const name = tNav(item.key);
                    return (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          render={<Link href={item.href} />}
                          isActive={isActive}
                          tooltip={
                            badge
                              ? rowTooltip(name, badge.count, badge.label)
                              : item.key === "settings"
                                ? tNav("projectSettings")
                                : name
                          }
                        >
                          <Icon />
                          <span>{name}</span>
                        </SidebarMenuButton>
                        {badge && <SidebarCountBadge {...badge} />}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {activeEnv && (
            <SidebarGroup>
              <SidebarGroupLabel className="truncate" title={activeEnv.name}>
                {stripProjectPrefix(activeEnv.name, activeProjectName)}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {environmentItems
                    .filter(
                      (item) => !item.perm || canProject(envRole, item.perm)
                    )
                    // Databases / Mock time need a db / backend service.
                    .filter((item) => {
                      const section = SERVICE_SECTION[item.key];
                      return !section || envSections.has(section);
                    })
                    // Mail only exists once a Mailpit is connected.
                    .filter(
                      (item) => item.key !== "mail" || activeEnv.hasMailpit
                    )
                    .map((item) => {
                      const itemPath = `/${activeEnv.key}/${activeEnv.slug}${item.url}`;
                      const isActive =
                        item.url === ""
                          ? pathname === itemPath
                          : pathname.startsWith(itemPath);
                      const badge =
                        item.key === "history"
                          ? {
                              count: envRunCount,
                              label: tNav("badgeActiveRuns", {
                                count: envRunCount,
                              }),
                            }
                          : null;
                      return (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            render={<Link href={itemPath} />}
                            isActive={isActive}
                            tooltip={
                              badge
                                ? rowTooltip(
                                    tNav(item.key),
                                    badge.count,
                                    badge.label
                                  )
                                : item.key === "settings"
                                  ? tNav("environmentSettings")
                                  : tNav(item.key)
                            }
                          >
                            <item.icon />
                            <span>{tNav(item.key)}</span>
                          </SidebarMenuButton>
                          {badge && (
                            <SidebarCountBadge
                              {...badge}
                              variant={
                                item.key === "history" ? "active" : "default"
                              }
                            />
                          )}
                        </SidebarMenuItem>
                      );
                    })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <UserMenu user={user} variant="sidebar" />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </div>
    </Sidebar>
  );
}
