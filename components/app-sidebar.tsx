"use client";

import {
  Aperture,
  BookOpen,
  CircleDot,
  Clock,
  DatabaseZap,
  FolderKanban,
  HardDrive,
  History,
  LayoutDashboard,
  Server,
  ServerCog,
  Settings,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
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
import { UserMenu } from "@/components/user-menu";
import { Link, usePathname } from "@/i18n/navigation";
import type { Environment } from "@/lib/db/schema";

const PROJECT_PATH_REGEX = /^\/projects\/([0-9a-f-]{20,})(?:\/|$)/i;

const projectItems = [
  { key: "dashboard", url: "", icon: LayoutDashboard, adminOnly: false },
  { key: "services", url: "/services", icon: ServerCog, adminOnly: false },
  {
    key: "databases",
    url: "/databases",
    icon: DatabaseZap,
    adminOnly: false,
  },
  { key: "mockTime", url: "/mock-time", icon: Clock, adminOnly: false },
  { key: "issues", url: "/issues", icon: CircleDot, adminOnly: false },
  { key: "history", url: "/history", icon: History, adminOnly: false },
  { key: "settings", url: "/settings", icon: Settings, adminOnly: true },
] as const;

type AppSidebarUser = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
};

export function AppSidebar({
  projects,
  isAdmin,
  user,
  side = "left",
}: {
  projects: Environment[];
  isAdmin: boolean;
  user: AppSidebarUser;
  side?: "left" | "right";
}) {
  const tApp = useTranslations("app");
  const tNav = useTranslations("nav");
  const pathname = usePathname();

  const match = PROJECT_PATH_REGEX.exec(pathname);
  const activeProjectId = match?.[1];
  const activeProject = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId) ?? null)
    : null;

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
              <span className="size-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                <Aperture className="size-4" />
              </span>
              <span className="font-semibold truncate">{tApp("name")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/" />}
                  isActive={pathname === "/"}
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
              {isAdmin && (
                <>
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
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      render={<Link href="/users" />}
                      isActive={pathname.startsWith("/users")}
                      tooltip={tNav("users")}
                    >
                      <Users />
                      <span>{tNav("users")}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {activeProject && (
          <SidebarGroup>
            <SidebarGroupLabel className="truncate">
              {activeProject.name}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projectItems
                  .filter((item) => !item.adminOnly || isAdmin)
                  .map((item) => {
                    const itemPath = `/projects/${activeProject.id}${item.url}`;
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
            <UserMenu user={user} isAdmin={isAdmin} variant="sidebar" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
