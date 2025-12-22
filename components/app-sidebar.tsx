"use client";

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
import { Project } from "@/lib/db/schema";
import { cn } from "@/lib/utils";
import {
  Database,
  DatabaseBackup,
  History,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  {
    title: "Dashboard",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Backup database",
    url: "/backup-database",
    icon: Database,
  },
  {
    title: "Restore database",
    url: "/restore-database",
    icon: DatabaseBackup,
  },
  {
    title: "History",
    url: "/history",
    icon: History,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
];

export function AppSidebar({ project }: { project: Project }) {
  const pathname = usePathname();

  const activeItem = items.find((i) => pathname.endsWith(i.url)) || items[0];

  return (
    <Sidebar className="absolute h-[calc(100vh-64px)] overflow-y-auto *:divide-y">
      <SidebarHeader className="px-4">
        <h2 className="text-xl font-bold">{project.name}</h2>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Menu</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const isActive = item.url === activeItem.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={`/projects/${project.id}${item.url}`}>
                        <item.icon strokeWidth={isActive ? 4 : 2} />
                        <span className={cn(isActive && "font-bold")}>
                          {item.title}
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
