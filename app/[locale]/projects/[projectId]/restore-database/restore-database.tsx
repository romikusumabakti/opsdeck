"use client";

import { Check, ChevronsUpDown } from "lucide-react";
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
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function RestoreDatabase({ backups }: { backups: Backup[] }) {
  const t = useTranslations("restoreDb");
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");

  const backup = backups.find((backup) => backup.name === value);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="w-96 justify-between"
            >
              {backup ? backup.name : t("selectBackup")}
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-96 p-0">
            <Command>
              <CommandInput placeholder={t("searchBackup")} className="h-9" />
              <CommandList>
                <CommandEmpty>{t("noBackup")}</CommandEmpty>
                <CommandGroup>
                  {backups.map((backup) => (
                    <CommandItem
                      key={backup.name}
                      value={backup.name}
                      onSelect={(currentValue) => {
                        setValue(currentValue === value ? "" : currentValue);
                        setOpen(false);
                      }}
                    >
                      {backup.name}
                      <Check
                        className={cn(
                          "ml-auto",
                          value === backup.name ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button>{t("restore")}</Button>
      </div>
      {backup &&
        (() => {
          const backupSize = parseInt(backup.size);
          return (
            <div className="text-sm">
              {t("backupSize", {
                sizeMb: (backupSize / 1_024 / 1_024).toFixed(2),
                sizeBytes: backupSize.toLocaleString(),
              })}
            </div>
          );
        })()}
    </div>
  );
}
