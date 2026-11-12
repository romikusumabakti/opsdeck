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
import type { DatabaseEntry } from "@/web/api/databases";

// Shared combobox for picking a target database. Used by backup, restore, and
// the manage-databases page. The environment's configured database is flagged with
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
  const selected = databases.find((d) => d.name === value) ?? null;

  return (
    <Combobox
      autoHighlight
      items={databases}
      value={selected}
      onValueChange={(db) => {
        if (db) onChange(db.name);
      }}
      itemToStringLabel={(db) => db.name}
      itemToStringValue={(db) => db.name}
      disabled={disabled}
    >
      <ComboboxTrigger
        render={
          <Button
            id={id}
            variant="outline"
            className="w-full justify-between font-normal"
          />
        }
      >
        <ComboboxValue>
          {(db: DatabaseEntry | null) =>
            db ? (
              <span className="truncate font-mono text-sm">
                {db.name}
                {db.isDefault ? ` ${defaultSuffix}` : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )
          }
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput showTrigger={false} placeholder={searchPlaceholder} />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(db: DatabaseEntry) => (
            <ComboboxItem key={db.name} value={db}>
              <span className="truncate font-mono text-sm">
                {db.name}
                {db.isDefault ? (
                  <span className="text-muted-foreground">
                    {" "}
                    {defaultSuffix}
                  </span>
                ) : null}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
