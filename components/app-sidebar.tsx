"use client";

import {
  Database,
  DatabaseBackup,
  History,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import type { Project } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

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

  return (
    <Sidebar className="absolute h-[calc(100vh-64px)] overflow-y-auto *:divide-y">
      <SidebarHeader className="px-4">
        <h2 className="text-xl font-bold">{project.name}</h2>
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
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={`/projects/${project.id}${item.url}`}>
                        <item.icon strokeWidth={isActive ? 4 : 2} />
                        <span className={cn(isActive && "font-bold")}>
                          {t(item.key)}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}
