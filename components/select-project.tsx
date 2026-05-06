"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
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
import type { Project } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export function SelectProject({ projects }: { projects: Project[] }) {
  const t = useTranslations("header");
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const params = useParams();

  const activeProject =
    projects.find((p) => p.id === parseInt(params.projectId as string)) ||
    projects[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-64 justify-between"
        >
          {activeProject ? activeProject.name : t("selectProject")}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t("searchProject")} className="h-9" />
          <CommandList>
            <CommandEmpty>{t("noProject")}</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.name}
                  value={project.name}
                  onSelect={() => {
                    setOpen(false);
                    router.push(`/projects/${project.id}`);
                  }}
                >
                  {project.name}
                  <Check
                    className={cn(
                      "ml-auto",
                      activeProject?.id === project.id
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
                value="__create-project"
                onSelect={() => {
                  setOpen(false);
                  router.push("/projects/new");
                }}
              >
                <Plus className="size-4" />
                {t("createProject")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
