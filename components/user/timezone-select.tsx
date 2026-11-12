import { useMemo } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";

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
  const defaultLabel = t("tzDefault", { zone: defaultZone });
  // The first item is the organisation default (`null`), then every IANA zone.
  const zones = useMemo<(string | null)[]>(
    () => [null, ...Intl.supportedValuesOf("timeZone")],
    []
  );
  const label = (zone: string | null) =>
    zone === null ? defaultLabel : zone.replaceAll("_", " ");

  return (
    <Combobox
      autoHighlight
      items={zones}
      value={value}
      onValueChange={(zone) => onChange(zone)}
      itemToStringLabel={(zone) =>
        zone === null ? `${defaultLabel} ${defaultZone}` : zone
      }
    >
      <ComboboxTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-between font-normal"
          />
        }
      >
        <ComboboxValue>
          {(zone: string | null) => (zone === null ? defaultLabel : zone)}
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput showTrigger={false} placeholder={t("tzSearch")} />
        <ComboboxEmpty>{t("tzNone")}</ComboboxEmpty>
        <ComboboxList>
          {(zone: string | null) => (
            <ComboboxItem key={zone ?? "default"} value={zone}>
              {label(zone)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
