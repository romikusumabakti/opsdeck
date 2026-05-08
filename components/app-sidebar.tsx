"use client";

import {
  Clock,
  Database,
  DatabaseBackup,
  History,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Copyright } from "@/components/copyright";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";

const projectItems = [
  { key: "dashboard", url: "", icon: LayoutDashboard, adminOnly: false },
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
  { key: "simulateTime", url: "/simulate-time", icon: Clock, adminOnly: false },
  { key: "history", url: "/history", icon: History, adminOnly: false },
  { key: "settings", url: "/settings", icon: Settings, adminOnly: true },
] as const;

export function AppSidebar({
  activeProject,
  isAdmin,
}: {
  activeProject: Project;
  isAdmin: boolean;
}) {
  const tNav = useTranslations("nav");
  const pathname = usePathname();
  const items = projectItems.filter((item) => !item.adminOnly || isAdmin);

  return (
    <Sidebar collapsible="icon" className="top-14 !h-[calc(100svh-3.5rem)]">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
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
      </SidebarContent>
      <SidebarFooter className="border-t p-3 group-data-[collapsible=icon]:hidden">
        <Copyright />
      </SidebarFooter>
    </Sidebar>
  );
}
