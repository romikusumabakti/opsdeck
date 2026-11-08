import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { FormControl } from "@/components/ui/form";
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
export function SaveButton() {
  const t = useTranslations("environmentForm");
  const { formState } = useSettingsFormContext();
  return (
    <div className="flex justify-end">
      <Button type="submit" disabled={formState.isSubmitting}>
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
}: {
  field: { value: string; onChange: (value: string) => void };
  options: readonly string[];
  getLabel: (value: string) => string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select
      value={field.value || null}
      onValueChange={(v) => field.onChange(v ?? "")}
      disabled={disabled}
    >
      <FormControl {...(id ? { id } : {})}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </FormControl>
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
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  servers: ServerOption[];
  disabled?: boolean;
}) {
  const t = useTranslations("environmentForm");
  return (
    <Select
      value={value || null}
      onValueChange={(v) => onChange(v ?? "")}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-server-select="" className="w-full">
        <SelectValue placeholder={t("pickServer")} />
      </SelectTrigger>
      <SelectContent>
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.host ? `${s.name} (${s.host})` : s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
