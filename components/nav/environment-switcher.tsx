"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { EnvironmentKindBadge } from "@/components/nav/environment-kind-badge";
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
import type { EnvironmentListItem } from "@/lib/db/schema";
import { stripProjectPrefix } from "@/lib/nav-path";
import { cn } from "@/lib/utils";

export function EnvironmentSwitcher({
  environments,
  activeEnvironment,
  projectName,
  createHref,
  onSelect,
}: {
  // The active project's environments, already in display order.
  environments: readonly EnvironmentListItem[];
  // Null on project-level pages: the trigger shows a placeholder.
  activeEnvironment: EnvironmentListItem | null;
  projectName: string;
  createHref: string | null;
  onSelect: (env: EnvironmentListItem) => void;
}) {
  const t = useTranslations("header");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  function select(env: EnvironmentListItem) {
    setOpen(false);
    if (env.id !== activeEnvironment?.id) onSelect(env);
  }

  const activeLabel = activeEnvironment
    ? stripProjectPrefix(activeEnvironment.name, projectName)
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label={
              activeLabel
                ? t("switchEnvironment", { name: activeLabel })
                : t("selectEnvironment")
            }
            className="gap-1.5 h-8 px-2 font-medium min-w-0"
          />
        }
      >
        {activeEnvironment ? (
          <>
            <span className="truncate max-w-[160px] sm:max-w-[300px]">
              {activeLabel}
            </span>
            <EnvironmentKindBadge kind={activeEnvironment.kind} />
          </>
        ) : (
          <span className="truncate text-muted-foreground">
            {t("selectEnvironment")}
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-60 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          {environments.length > 0 && (
            <CommandInput
              placeholder={t("searchEnvironment")}
              className="h-9"
            />
          )}
          <CommandList>
            {environments.length > 0 ? (
              <>
                <CommandEmpty>{t("noEnvironment")}</CommandEmpty>
                <CommandGroup>
                  {environments.map((env) => (
                    <CommandItem
                      key={env.id}
                      value={`${env.name} ${env.slug}`}
                      onSelect={() => select(env)}
                    >
                      <span className="flex-1 min-w-0 truncate">
                        {stripProjectPrefix(env.name, projectName)}
                      </span>
                      <EnvironmentKindBadge kind={env.kind} />
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          env.id === activeEnvironment?.id
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("noEnvironmentInProject")}
              </p>
            )}
            {createHref && (
              <>
                {environments.length > 0 && <CommandSeparator />}
                <CommandGroup>
                  <CommandItem
                    value="__create-environment"
                    onSelect={() => {
                      setOpen(false);
                      router.push(createHref);
                    }}
                  >
                    <Plus className="size-4" />
                    {t("createEnvironment")}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
