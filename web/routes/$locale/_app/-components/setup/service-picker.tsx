import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

type PickerService = { componentKey: string; repoFullName: string };

/**
 * Adds a registered service to the New environment page: the services it may
 * deploy (the project's, when it has sources) not picked yet, by key with
 * their repository, searchable by either.
 */
export function ServicePicker({
  label,
  services,
  onPick,
}: {
  label: string;
  services: readonly PickerService[];
  onPick: (componentKey: string) => void;
}) {
  const t = useTranslations("newEnvironment");
  const sorted = [...services].sort((a, b) =>
    a.componentKey.localeCompare(b.componentKey)
  );
  return (
    <Combobox<PickerService>
      autoHighlight
      items={sorted}
      // Add-only picker: nothing stays selected.
      value={null}
      onValueChange={(service) => {
        if (service) onPick(service.componentKey);
      }}
      itemToStringLabel={(s) => `${s.componentKey} ${s.repoFullName}`}
      itemToStringValue={(s) => s.componentKey}
    >
      {/* Base UI's trigger, not ComboboxTrigger: that one appends a chevron. */}
      <ComboboxPrimitive.Trigger
        data-slot="combobox-trigger"
        render={
          <Button
            id="env-service-picker"
            type="button"
            variant="outline"
            className="w-fit"
          />
        }
      >
        <Plus data-icon="inline-start" />
        {label}
      </ComboboxPrimitive.Trigger>
      <ComboboxContent className="w-96">
        <ComboboxInput showTrigger={false} placeholder={t("searchServices")} />
        <ComboboxEmpty>{t("noServices")}</ComboboxEmpty>
        <ComboboxList>
          {(service: PickerService) => (
            <ComboboxItem key={service.componentKey} value={service}>
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {service.componentKey}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {service.repoFullName}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
