"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const PROJECT_PATH_REGEX = /^\/projects\/([0-9a-f-]{20,})(?:\/|$)/i;

type StaticCrumb = { href: string; labelKey: "nav.servers" | "nav.projects" };

function getStaticCrumb(pathname: string): StaticCrumb | null {
  // /servers/[id] or /servers/new — back to /servers list
  if (pathname.startsWith("/servers/")) {
    return { href: "/servers", labelKey: "nav.servers" };
  }
  // /projects/new — back to / (project list home)
  if (pathname === "/projects/new") {
    return { href: "/", labelKey: "nav.projects" };
  }
  return null;
}

function Slash() {
  return (
    <span
      className="text-muted-foreground/60 text-lg font-light select-none"
      aria-hidden="true"
    >
      /
    </span>
  );
}

export function HeaderBreadcrumb({ projects }: { projects: Project[] }) {
  const pathname = usePathname();
  const t = useTranslations();

  // Project context: render switcher
  const match = PROJECT_PATH_REGEX.exec(pathname);
  const activeProjectId = match?.[1];
  const activeProject = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId) ?? null)
    : null;

  if (activeProject) {
    return (
      <>
        <Slash />
        <ProjectSwitcher projects={projects} activeProject={activeProject} />
      </>
    );
  }

  // Static breadcrumb for deep non-project routes
  const crumb = getStaticCrumb(pathname);
  if (crumb) {
    return (
      <>
        <Slash />
        <Link
          href={crumb.href}
          className="text-sm font-medium hover:text-foreground text-muted-foreground transition-colors px-2 h-8 inline-flex items-center rounded-md hover:bg-accent"
        >
          {t(crumb.labelKey)}
        </Link>
      </>
    );
  }

  return null;
}

function ProjectSwitcher({
  projects,
  activeProject,
}: {
  projects: Project[];
  activeProject: Project;
}) {
  const router = useRouter();
  const tHeader = useTranslations("header");
  const [open, setOpen] = React.useState(false);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="gap-1.5 h-8 px-2 font-medium"
        >
          <span className="truncate max-w-[140px] sm:max-w-[240px]">
            {activeProject.name}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={tHeader("searchProject")}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>{tHeader("noProject")}</CommandEmpty>
            {projects.length > 0 && (
              <CommandGroup>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={project.name}
                    onSelect={() => go(`/projects/${project.id}`)}
                  >
                    <span className="size-5 rounded bg-primary/10 text-primary flex items-center justify-center text-[10px] font-semibold shrink-0">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate">{project.name}</span>
                    <Check
                      className={cn(
                        "ml-auto size-4 shrink-0",
                        activeProject.id === project.id
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__create-project"
                onSelect={() => go("/projects/new")}
              >
                <Plus className="size-4" />
                {tHeader("createProject")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
