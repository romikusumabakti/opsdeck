"use client";

import {
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
  { key: "dashboard", url: "", icon: LayoutDashboard },
  { key: "backupDatabase", url: "/backup-database", icon: Database },
  { key: "restoreDatabase", url: "/restore-database", icon: DatabaseBackup },
  { key: "history", url: "/history", icon: History },
  { key: "settings", url: "/settings", icon: Settings },
] as const;

export function AppSidebar({ activeProject }: { activeProject: Project }) {
  const tNav = useTranslations("nav");
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon" className="top-14 !h-[calc(100svh-3.5rem)]">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {projectItems.map((item) => {
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
