"use client";

import {
  Aperture,
  Clock,
  Database,
  DatabaseBackup,
  DatabaseZap,
  FolderKanban,
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
import type { Project } from "@/lib/db/schema";

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
  {
    key: "backupDatabase",
    url: "/backup-database",
    icon: Database,
    adminOnly: false,
  },
  {
    key: "restoreDatabase",
    url: "/restore-database",
    icon: DatabaseBackup,
    adminOnly: false,
  },
  { key: "mockTime", url: "/mock-time", icon: Clock, adminOnly: false },
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
  projects: Project[];
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
            <SidebarMenuButton asChild size="lg" tooltip={tApp("name")}>
              <Link href="/">
                <span className="size-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                  <Aperture className="size-4" />
                </span>
                <span className="font-semibold truncate">{tApp("name")}</span>
              </Link>
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
                  asChild
                  isActive={pathname === "/"}
                  tooltip={tNav("projects")}
                >
                  <Link href="/">
                    <FolderKanban />
                    <span>{tNav("projects")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {isAdmin && (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname.startsWith("/servers")}
                      tooltip={tNav("servers")}
                    >
                      <Link href="/servers">
                        <Server />
                        <span>{tNav("servers")}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname.startsWith("/users")}
                      tooltip={tNav("users")}
                    >
                      <Link href="/users">
                        <Users />
                        <span>{tNav("users")}</span>
                      </Link>
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
                          asChild
                          isActive={isActive}
                          tooltip={tNav(item.key)}
                        >
                          <Link href={itemPath}>
                            <item.icon />
                            <span>{tNav(item.key)}</span>
                          </Link>
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
