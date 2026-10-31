import { Check, ListFilter } from "lucide-react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
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

export type FacetOption = {
  value: string;
  label: string;
  /** Rows carrying this value; shown beside the label. */
  count?: number;
};

/**
 * Multi-select filter: a button naming the facet (with the selection summarised
 * as a count badge) that opens a searchable checklist. Controlled — the caller
 * owns `selected`; an empty list means "no filter".
 */
export function FacetedFilter({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: FacetOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const t = useTranslations("dataTable");
  const active = new Set(selected);

  const toggle = (value: string) => {
    const next = new Set(active);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="border-dashed" />
        }
      >
        <ListFilter className="size-4" />
        {title}
        {selected.length > 0 && (
          <Badge variant="secondary" className="px-1.5 tabular-nums">
            {selected.length}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-0 p-0">
        <Command>
          <CommandInput placeholder={title} />
          <CommandList>
            <CommandEmpty>{t("noResults")}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isOn = active.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    data-checked={isOn || undefined}
                    onSelect={() => toggle(option.value)}
                  >
                    <Check
                      className={cn("size-4", !isOn && "invisible")}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{option.label}</span>
                    {option.count != null && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {option.count}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
