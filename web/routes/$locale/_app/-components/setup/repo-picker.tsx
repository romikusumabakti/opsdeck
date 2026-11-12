import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import * as React from "react";
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
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { type SetupRepoRow, setupReposQuery } from "@/web/api/setup";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Whether a repository may join the list: not twice, and not one of another
 * app. A list of only unregistered repositories makes a new app, so then any
 * registered repository is another app's.
 */
export function repoPickable(
  row: Pick<SetupRepoRow, "repoFullName" | "appKey">,
  picked: readonly string[],
  currentAppKey: string | null
): boolean {
  if (picked.includes(row.repoFullName)) return false;
  if (row.appKey === null) return true;
  return currentAppKey === null
    ? picked.length === 0
    : row.appKey === currentAppKey;
}

/**
 * The repository search (the CI server's repositories). Repositories that
 * cannot be picked are listed disabled, with the app that owns them.
 */
export function RepoPicker({
  label,
  picked,
  currentAppKey,
  onPick,
}: {
  label: string;
  picked: string[];
  currentAppKey: string | null;
  onPick: (row: SetupRepoRow) => void;
}) {
  const t = useTranslations("newEnvironment");
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const debounced = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const rows = useQuery({ ...setupReposQuery(debounced), enabled: open });
  const loading = rows.isPending || (rows.isFetching && q !== debounced);
  return (
    <Combobox<SetupRepoRow>
      autoHighlight
      items={rows.data ?? []}
      // Add-only picker: nothing stays selected, and the server filters by query.
      value={null}
      onValueChange={(row) => {
        if (row) onPick(row);
      }}
      filter={null}
      inputValue={q}
      onInputValueChange={setQ}
      onOpenChange={setOpen}
      itemToStringLabel={(row) => row.repoFullName}
      itemToStringValue={(row) => `${row.ciConnectionId}:${row.repoFullName}`}
    >
      {/* Base UI's trigger, not ComboboxTrigger: that one appends a chevron. */}
      <ComboboxPrimitive.Trigger
        data-slot="combobox-trigger"
        render={
          <Button
            id="env-repo-picker"
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
        <ComboboxInput showTrigger={false} placeholder={t("searchRepos")} />
        <ComboboxEmpty>
          {rows.isPending ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("reposLoading")}
            </span>
          ) : rows.isError ? (
            t("reposFailed")
          ) : (
            t("noRepos")
          )}
        </ComboboxEmpty>
        <ComboboxList aria-busy={loading || undefined}>
          {(row: SetupRepoRow) => (
            <ComboboxItem
              key={`${row.ciConnectionId}:${row.repoFullName}`}
              value={row}
              disabled={!repoPickable(row, picked, currentAppKey)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {row.repoFullName}
              </span>
              {row.appName && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.appName}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
