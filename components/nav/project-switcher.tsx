"use client";

import { Check, ChevronDown, FolderKanban, FolderPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
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
import { useRouter } from "@/i18n/navigation";
import type { NavProject } from "@/lib/nav-path";
import { cn } from "@/lib/utils";

export function ProjectSwitcher({
  projects,
  activeProject,
  canCreateProject,
  onSelect,
}: {
  projects: readonly NavProject[];
  activeProject: NavProject;
  canCreateProject: boolean;
  onSelect: (project: NavProject) => void;
}) {
  const t = useTranslations("header");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  function select(project: NavProject) {
    setOpen(false);
    if (project.id !== activeProject.id) onSelect(project);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label={t("switchProject", { name: activeProject.name })}
            className="gap-1.5 h-8 px-2 font-medium min-w-0"
          />
        }
      >
        <span className="truncate max-w-[120px] sm:max-w-[220px]">
          {activeProject.name}
        </span>
        <ChevronDown className="size-3.5 opacity-60 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t("searchProject")} className="h-9" />
          <CommandList>
            <CommandEmpty>{t("noProject")}</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  // Name and key, so typing either finds the project.
                  value={`${project.name} ${project.key}`}
                  onSelect={() => select(project)}
                >
                  <span className="flex-1 min-w-0 truncate">
                    {project.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {project.key}
                  </span>
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      project.id === activeProject.id
                        ? "opacity-100"
                        : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__all-projects"
                onSelect={() => {
                  setOpen(false);
                  router.push("/projects");
                }}
              >
                <FolderKanban className="size-4" />
                {t("allProjects")}
              </CommandItem>
              {canCreateProject && (
                <CommandItem
                  value="__create-project"
                  onSelect={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <FolderPlus className="size-4" />
                  {t("createProject")}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>

      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />
    </Popover>
  );
}
