import {
  Activity,
  BookOpen,
  Cable,
  CircleDot,
  Clock,
  Cloud,
  DatabaseZap,
  FolderKanban,
  HardDrive,
  History,
  House,
  LayoutDashboard,
  type LucideIcon,
  Mail,
  Server,
  ServerCog,
  Settings,
  ShieldUser,
  Users,
  UsersRound,
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
import { parseNavPath, SECTION_PERMS } from "@/lib/nav-path";
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

type ProjectItem = {
  key: string;
  url: string;
  icon: LucideIcon;
  perm?: ProjectPermissions;
};

const projectItems: ProjectItem[] = [
  { key: "dashboard", url: "", icon: LayoutDashboard },
  { key: "services", url: "/services", icon: ServerCog },
  { key: "databases", url: "/databases", icon: DatabaseZap },
  {
    key: "mockTime",
    url: "/mock-time",
    icon: Clock,
    perm: SECTION_PERMS["mock-time"],
  },
  { key: "mail", url: "/mail", icon: Mail, perm: SECTION_PERMS.mail },
  { key: "issues", url: "/issues", icon: CircleDot },
  { key: "history", url: "/history", icon: History },
  {
    key: "settings",
    url: "/settings",
    icon: Settings,
    perm: SECTION_PERMS.settings,
  },
];

// Sections of the /admin area, shown as their own sidebar group while the
// user is inside it. Each page enforces the same permission server-side.
const adminItems: {
  key: string;
  url: string;
  icon: LucideIcon;
  perm: OrgPermissions;
}[] = [
  {
    key: "activity",
    url: "/admin/activity",
    icon: Activity,
    perm: { audit: ["read"] },
  },
  {
    key: "jira",
    url: "/admin/jira",
    icon: Cable,
    perm: { integration: ["manage"] },
  },
  {
    key: "tunnels",
    url: "/admin/tunnels",
    icon: Cloud,
    perm: { tunnel: ["read"] },
  },
  { key: "users", url: "/admin/users", icon: Users, perm: { user: ["list"] } },
];

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
  orgRole,
  projectRoles,
  issueCounts,
  user,
  logo,
  side = "left",
}: {
  environments: EnvironmentListItem[];
  orgRole: OrgRole;
  projectRoles: Record<string, ProjectRole>;
  issueCounts: AssignedIssueCounts;
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

  const envRole = activeEnv
    ? (projectRoles[activeEnv.projectId] ?? null)
    : null;

  // Issues live on the environment's parent project, so the group badge counts
  // that project — the same set the env's Issues page lists.
  const envIssueCount = activeEnv
    ? (issueCounts.byProject[activeEnv.projectId] ?? 0)
    : 0;
  // Live from the shared run stream: the History badge is "something is
  // happening right now", not a stored count.
  const envRunCount = useActiveRunCount(activeEnv?.id ?? null);
  const anyRunActive = useActiveRuns().length > 0;

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

      <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden">
        <SidebarMotif />
        <SidebarContent>
          <SidebarGroup>
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
                    tooltip={tNav("allIssues")}
                  >
                    <CircleDot />
                    <span>{tNav("allIssues")}</span>
                  </SidebarMenuButton>
                  <SidebarCountBadge
                    count={issueCounts.total}
                    label={tNav("badgeAssignedIssues", {
                      count: issueCounts.total,
                    })}
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

          {/* The admin sections only appear once you're inside /admin, the same
            way the environment sections appear inside an environment. */}
          {inAdmin && (
            <SidebarGroup>
              <SidebarGroupLabel>{tNav("admin")}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {adminItems
                    .filter((item) => canOrg(orgRole, item.perm))
                    .map((item) => (
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
          )}

          {activeEnv && (
            <SidebarGroup>
              <SidebarGroupLabel className="truncate">
                {activeEnv.name}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {projectItems
                    .filter(
                      (item) => !item.perm || canProject(envRole, item.perm)
                    )
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
                      return (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            render={<Link href={itemPath} />}
                            isActive={isActive}
                            tooltip={tNav(item.key)}
                          >
                            <item.icon />
                            <span>{tNav(item.key)}</span>
                          </SidebarMenuButton>
                          {item.key === "issues" && (
                            <SidebarCountBadge
                              count={envIssueCount}
                              label={tNav("badgeAssignedIssues", {
                                count: envIssueCount,
                              })}
                            />
                          )}
                          {item.key === "history" && (
                            <SidebarCountBadge
                              count={envRunCount}
                              variant="active"
                              label={tNav("badgeActiveRuns", {
                                count: envRunCount,
                              })}
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
