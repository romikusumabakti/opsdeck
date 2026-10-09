"use client";

import { ChevronsUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** IANA zone picker. `null` means "use the organisation default". */
export function TimezoneSelect({
  value,
  defaultZone,
  onChange,
}: {
  value: string | null;
  defaultZone: string;
  onChange: (zone: string | null) => void;
}) {
  const t = useTranslations("profile");
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);

  function pick(zone: string | null) {
    onChange(zone);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-between font-normal"
          />
        }
      >
        {value ?? t("tzDefault", { zone: defaultZone })}
        <ChevronsUpDown className="opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) p-0">
        <Command>
          <CommandInput placeholder={t("tzSearch")} />
          <CommandList>
            <CommandEmpty>{t("tzNone")}</CommandEmpty>
            <CommandItem
              value={`default ${defaultZone}`}
              onSelect={() => pick(null)}
            >
              {t("tzDefault", { zone: defaultZone })}
            </CommandItem>
            {zones.map((zone) => (
              <CommandItem key={zone} value={zone} onSelect={() => pick(zone)}>
                {zone.replaceAll("_", " ")}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
