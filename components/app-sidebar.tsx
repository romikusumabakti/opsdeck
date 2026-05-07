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
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";

const items = [
  {
    key: "dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    key: "backupDatabase",
    url: "/backup-database",
    icon: Database,
  },
  {
    key: "restoreDatabase",
    url: "/restore-database",
    icon: DatabaseBackup,
  },
  {
    key: "history",
    url: "/history",
    icon: History,
  },
  {
    key: "settings",
    url: "/settings",
    icon: Settings,
  },
] as const;

export function AppSidebar({ project }: { project: Project }) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  const activeItem = items.find((i) => pathname.endsWith(i.url)) || items[0];
  const initial = (project.name || "?").charAt(0).toUpperCase();

  return (
    <Sidebar className="absolute h-full border-r">
      <SidebarHeader className="px-3 py-3 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <span className="size-9 rounded-md bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">
            {initial}
          </span>
          <h2
            className="font-semibold truncate leading-tight"
            title={project.name}
          >
            {project.name}
          </h2>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("menu")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive = item.url === activeItem.url;
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={t(item.key)}
                    >
                      <Link href={`/projects/${project.id}${item.url}`}>
                        <item.icon />
                        <span>{t(item.key)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-4 py-3 border-t">
        <Copyright />
      </SidebarFooter>
    </Sidebar>
  );
}
