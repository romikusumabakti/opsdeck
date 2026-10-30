import { useTranslations } from "use-intl";
import { Checkbox } from "@/components/ui/checkbox";
import type { UserFilterState } from "./types";

// Shared by the Users and Project access tables; the shell owns the state so
// switching tabs keeps the same filter.
export function UserFilters({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: UserFilterState;
  onChange: (next: UserFilterState) => void;
}) {
  const t = useTranslations("access");
  return (
    <div className="flex items-center gap-4 text-sm">
      <label
        htmlFor={`${idPrefix}-filter-inactive`}
        className="flex items-center gap-2"
      >
        <Checkbox
          id={`${idPrefix}-filter-inactive`}
          checked={value.inactiveOnly}
          onCheckedChange={(v) =>
            onChange({ ...value, inactiveOnly: v === true })
          }
        />
        {t("filterInactive")}
      </label>
      <label
        htmlFor={`${idPrefix}-filter-banned`}
        className="flex items-center gap-2"
      >
        <Checkbox
          id={`${idPrefix}-filter-banned`}
          checked={value.showBanned}
          onCheckedChange={(v) =>
            onChange({ ...value, showBanned: v === true })
          }
        />
        {t("filterBanned")}
      </label>
    </div>
  );
}
