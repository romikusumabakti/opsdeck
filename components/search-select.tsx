import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { useTranslations } from "use-intl";
import type { PickerTrigger } from "@/components/compact-trigger";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { cn } from "@/lib/utils";

export type SearchSelectOption = {
  value: string;
  label: string;
  /** Shown muted next to the label (e.g. a host); searchable. */
  hint?: string;
  /** Extra searchable text that is not shown (e.g. an issue number). */
  keywords?: string;
  /** Listed but not pickable (e.g. already taken). */
  disabled?: boolean;
};

/**
 * A searchable single-value picker for lists that come from data and can
 * grow (servers, issues, projects…). Search matches the label, the hint and
 * the keywords, case-insensitively. `null` means "none"; it is only offered,
 * as the first item, when `noneLabel` is set. Fixed enums stay on `Select`.
 */
export function SearchSelect({
  id,
  value,
  onChange,
  options,
  placeholder,
  noneLabel,
  disabled,
  invalid,
  className,
  "aria-label": ariaLabel,
  triggerProps,
  trigger,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: readonly SearchSelectOption[];
  placeholder: string;
  noneLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  "aria-label"?: string;
  triggerProps?: Record<`data-${string}`, string>;
  /** A caller-drawn trigger (issue property chips); replaces the button. */
  trigger?: PickerTrigger;
}) {
  const t = useTranslations("common");
  const byValue = new Map(options.map((o) => [o.value, o]));
  const items: (string | null)[] = [
    ...(noneLabel === undefined ? [] : [null]),
    ...options.map((o) => o.value),
  ];

  function triggerContent() {
    if (value === null || value === "") {
      return noneLabel !== undefined ? (
        <span className="truncate">{noneLabel}</span>
      ) : (
        <span className="truncate text-muted-foreground">{placeholder}</span>
      );
    }
    const option = byValue.get(value);
    // A value outside the list (still loading, or since removed) shows the
    // placeholder rather than a raw id.
    if (!option) {
      return (
        <span className="truncate text-muted-foreground">{placeholder}</span>
      );
    }
    return <OptionText option={option} />;
  }

  return (
    <Combobox
      autoHighlight
      items={items}
      value={value === "" ? null : value}
      onValueChange={(next) => {
        // Re-picking the current item is not a change.
        if (next !== (value === "" ? null : value)) onChange(next);
      }}
      itemToStringLabel={(item: string | null) => {
        if (item === null) return noneLabel ?? "";
        const o = byValue.get(item);
        return o ? [o.label, o.hint, o.keywords].filter(Boolean).join(" ") : "";
      }}
      disabled={disabled}
    >
      {trigger ? (
        <ComboboxPrimitive.Trigger render={trigger.render} disabled={disabled}>
          {trigger.content}
        </ComboboxPrimitive.Trigger>
      ) : (
        <ComboboxTrigger
          render={
            <Button
              variant="outline"
              className={cn(
                "h-8 w-full justify-between font-normal",
                className
              )}
              id={id}
              aria-label={ariaLabel}
              aria-invalid={invalid}
              disabled={disabled}
              {...triggerProps}
            />
          }
        >
          {triggerContent()}
        </ComboboxTrigger>
      )}
      <ComboboxContent className={trigger ? "w-72" : undefined}>
        <ComboboxInput showTrigger={false} placeholder={t("search")} />
        <ComboboxEmpty>{t("noResults")}</ComboboxEmpty>
        <ComboboxList>
          {(item: string | null) => {
            if (item === null) {
              return (
                <ComboboxItem key="none" value={null}>
                  {noneLabel}
                </ComboboxItem>
              );
            }
            const o = byValue.get(item);
            if (!o) return null;
            return (
              <ComboboxItem key={o.value} value={o.value} disabled={o.disabled}>
                <OptionText option={o} />
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function OptionText({ option }: { option: SearchSelectOption }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate">{option.label}</span>
      {option.hint ? (
        <span className="truncate text-xs text-muted-foreground">
          {option.hint}
        </span>
      ) : null}
    </span>
  );
}
