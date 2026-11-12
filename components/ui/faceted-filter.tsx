import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { ListFilter } from "lucide-react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

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

  return (
    <Combobox
      multiple
      autoHighlight
      items={options}
      value={options.filter((option) => active.has(option.value))}
      onValueChange={(next: FacetOption[]) =>
        onChange(next.map((option) => option.value))
      }
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
    >
      {/* Base UI's trigger, not ComboboxTrigger: that one appends a chevron. */}
      <ComboboxPrimitive.Trigger
        data-slot="combobox-trigger"
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
      </ComboboxPrimitive.Trigger>
      <ComboboxContent align="start" className="w-56">
        <ComboboxInput showTrigger={false} placeholder={title} />
        <ComboboxEmpty>{t("noResults")}</ComboboxEmpty>
        <ComboboxList>
          {(option: FacetOption) => (
            <ComboboxItem key={option.value} value={option}>
              <span className="flex-1 truncate">{option.label}</span>
              {option.count != null && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {option.count}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
