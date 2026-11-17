import { useTranslations } from "use-intl";
import { SearchSelect } from "@/components/search-select";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ServerOption, useSettingsFormContext } from "./settings-form";

// Field building blocks shared by the Settings tabs.

/** A tab's save button; submitting runs the tab's save. */
export function SaveButton({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations("environmentForm");
  const { formState } = useSettingsFormContext();
  return (
    <div className="flex justify-end">
      <Button type="submit" disabled={disabled || formState.isSubmitting}>
        {formState.isSubmitting ? t("submitting") : t("saveChanges")}
      </Button>
    </div>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

// A form-bound Select for a fixed set of string options.
export function EnumSelect({
  field,
  options,
  getLabel,
  placeholder,
  disabled,
  id,
  invalid,
}: {
  field: { value: string; onChange: (value: string) => void };
  options: readonly string[];
  getLabel: (value: string) => string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
}) {
  return (
    <Select
      value={field.value || null}
      onValueChange={(v) => field.onChange(v ?? "")}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-invalid={invalid} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((v) => (
          <SelectItem key={v} value={v}>
            {getLabel(v)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A server select. `data-server-select` marks every server picker on the page
 * (the simple one and the per-service ones under Advanced options).
 */
export function ServerSelect({
  id,
  value,
  onChange,
  servers,
  disabled,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  servers: ServerOption[];
  disabled?: boolean;
  invalid?: boolean;
}) {
  const t = useTranslations("environmentForm");
  return (
    <SearchSelect
      id={id}
      value={value || null}
      onChange={(v) => onChange(v ?? "")}
      options={servers.map((s) => ({
        value: s.id,
        label: s.name,
        hint: s.host || undefined,
      }))}
      placeholder={t("pickServer")}
      disabled={disabled}
      invalid={invalid}
      triggerProps={{ "data-server-select": "" }}
    />
  );
}
