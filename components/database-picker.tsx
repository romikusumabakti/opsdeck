"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import type { DatabaseEntry } from "@/actions/databases";
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

// Shared combobox for picking a target database. Used by backup, restore, and
// the manage-databases page. The project's configured database is flagged with
// a "(default)" suffix so operators know which one the panel is wired to.
export function DatabasePicker({
  id,
  databases,
  value,
  onChange,
  disabled,
  defaultSuffix,
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  id?: string;
  databases: DatabaseEntry[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  defaultSuffix: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = databases.find((d) => d.name === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
        >
          {selected ? (
            <span className="truncate font-mono text-xs">
              {selected.name}
              {selected.isDefault ? ` ${defaultSuffix}` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popper-anchor-width)] p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {databases.map((d) => (
                <CommandItem
                  key={d.name}
                  value={d.name}
                  onSelect={(currentValue) => {
                    onChange(currentValue);
                    // Defer close past the click so Radix's dismiss + focus
                    // restore doesn't race the same tick (reopen flicker).
                    requestAnimationFrame(() => setOpen(false));
                  }}
                >
                  <span className="truncate font-mono text-xs">
                    {d.name}
                    {d.isDefault ? (
                      <span className="text-muted-foreground">
                        {" "}
                        {defaultSuffix}
                      </span>
                    ) : null}
                  </span>
                  <Check
                    className={cn(
                      "ml-auto",
                      value === d.name ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
