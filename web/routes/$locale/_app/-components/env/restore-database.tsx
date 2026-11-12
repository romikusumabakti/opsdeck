import { ChevronDown, RotateCcw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { DatabasePicker } from "@/components/database-picker";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { backendService, dbService } from "@/lib/services";
import type { Backup } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getBackupList, restoreDatabaseBackup } from "@/web/api/backups";
import type { DatabaseEntry } from "@/web/api/databases";
import type {
  EnvironmentListItem,
  EnvironmentWithServers,
} from "@/web/api/environments";

type SourceOption = { id: string; name: string; self: boolean };

export function RestoreDatabase({
  environment,
  backups,
  databases,
  sourceEnvironments,
  initialBackup = "",
}: {
  environment: EnvironmentWithServers;
  backups: Backup[];
  databases: DatabaseEntry[];
  // Other projects sharing this environment's DB location, offered as alternative
  // backup sources. Empty when the environment has no compatible siblings.
  sourceEnvironments: EnvironmentListItem[];
  // Backup file to pre-select (from this environment's own list).
  initialBackup?: string;
}) {
  const t = useTranslations("restoreDb");
  const tCommon = useTranslations("common");
  const canRunOps = useProjectCan({ database: ["restore"] });
  const dialog = useDialog();
  const [value, setValue] = React.useState(initialBackup);
  const [database, setDatabase] = React.useState(
    dbService(environment).dbName ?? ""
  );
  const [restartBackend, setRestartBackend] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [submitting, startTransition] = React.useTransition();

  // Backup source. Defaults to this environment; the picker (shown only when
  // compatible siblings exist) can switch it. Switching re-fetches the chosen
  // environment's backup list and clears the selected file.
  // Advanced controls (restore into a non-default DB, or from another environment)
  // stay hidden until opened so the common path is a single backup + Restore.
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [sourceEnvironmentId, setSourceEnvironmentId] = React.useState(
    environment.id
  );
  const [sourceBackups, setSourceBackups] = React.useState<Backup[]>(backups);
  const [loadingBackups, setLoadingBackups] = React.useState(false);

  const isCrossEnvironment = sourceEnvironmentId !== environment.id;
  const sourceEnvironment = sourceEnvironments.find(
    (p) => p.id === sourceEnvironmentId
  );
  const sourceName = sourceEnvironment?.name ?? environment.name;
  const sourceOptions: SourceOption[] = [
    { id: environment.id, name: environment.name, self: true },
    ...sourceEnvironments.map((p) => ({ id: p.id, name: p.name, self: false })),
  ];
  const sourceOption =
    sourceOptions.find((o) => o.id === sourceEnvironmentId) ?? null;

  function onSourceChange(nextId: string) {
    if (nextId === sourceEnvironmentId) return;
    setSourceEnvironmentId(nextId);
    setValue("");
    if (nextId === environment.id) {
      // Reuse the server-rendered list for the current environment — no round-trip.
      setSourceBackups(backups);
      return;
    }
    setLoadingBackups(true);
    void (async () => {
      try {
        const res = await getBackupList(nextId);
        setSourceBackups(res.success ? res.data : []);
        if (!res.success) toast.error(res.error);
      } catch {
        setSourceBackups([]);
        toast.error(tCommon("errorGeneric"));
      } finally {
        setLoadingBackups(false);
      }
    })();
  }

  const backup = sourceBackups.find((b) => b.name === value);
  const isDefaultDatabase =
    databases.find((d) => d.name === database)?.isDefault ?? false;

  // Restarting the backend only makes sense when restoring the default
  // database (the one the backend is wired to). Drop a stale checked state
  // when the operator switches to a non-default target.
  function onDatabaseChange(next: string) {
    setDatabase(next);
    const nextIsDefault =
      databases.find((d) => d.name === next)?.isDefault ?? false;
    if (!nextIsDefault) setRestartBackend(false);
  }

  const runRestore = React.useCallback(() => {
    if (!backup) return;
    startTransition(async () => {
      try {
        const { runId } = await restoreDatabaseBackup(environment.id, {
          filename: backup.name,
          restartBackend,
          database,
          sourceEnvironmentId: isCrossEnvironment
            ? sourceEnvironmentId
            : undefined,
        });
        setActiveTaskId(runId);
        toast.success(t("successTitle"), {
          description: t("successDescription", { dbName: database }),
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      }
    });
  }, [
    backup,
    environment,
    restartBackend,
    database,
    isCrossEnvironment,
    sourceEnvironmentId,
    t,
    tCommon,
  ]);

  function onRestore() {
    if (!backup) return;
    void (async () => {
      const ok = await dialog.confirm({
        title: t("confirmTitle"),
        description: isCrossEnvironment
          ? t("confirmDescriptionCrossEnvironment", {
              filename: backup.name,
              dbName: database,
              sourceName,
            })
          : t("confirmDescription", {
              filename: backup.name,
              dbName: database,
            }),
        confirmText: t("restore"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      runRestore();
    })();
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
        className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            "size-4 transition-transform",
            advancedOpen && "rotate-180"
          )}
        />
        {t("advancedOptions")}
      </button>
      {advancedOpen && (
        <>
          {sourceEnvironments.length > 0 && (
            <>
              <Label htmlFor="restore-source-picker">
                {t("sourceEnvironmentLabel")}
              </Label>
              <Combobox
                autoHighlight
                items={sourceOptions}
                value={sourceOption}
                onValueChange={(option) => {
                  if (option) onSourceChange(option.id);
                }}
                itemToStringLabel={(option) => option.name}
                itemToStringValue={(option) => option.id}
                disabled={submitting}
              >
                <ComboboxTrigger
                  render={
                    <Button
                      id="restore-source-picker"
                      variant="outline"
                      className="justify-between font-normal"
                    />
                  }
                >
                  <span className="truncate">
                    {sourceName}
                    {!isCrossEnvironment && (
                      <span className="text-muted-foreground">
                        {" "}
                        {t("sourceSelfSuffix")}
                      </span>
                    )}
                  </span>
                </ComboboxTrigger>
                <ComboboxContent>
                  <ComboboxInput
                    showTrigger={false}
                    placeholder={t("searchEnvironment")}
                  />
                  <ComboboxEmpty>{t("noEnvironment")}</ComboboxEmpty>
                  <ComboboxList>
                    {(option: SourceOption) => (
                      <ComboboxItem key={option.id} value={option}>
                        <span className="truncate">
                          {option.name}
                          {option.self && (
                            <span className="text-muted-foreground">
                              {" "}
                              {t("sourceSelfSuffix")}
                            </span>
                          )}
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <p className="text-xs text-muted-foreground">
                {t("sourceEnvironmentHint")}
              </p>
            </>
          )}
          <Label htmlFor="restore-database-picker">
            {t("targetDatabaseLabel")}
          </Label>
          <DatabasePicker
            id="restore-database-picker"
            databases={databases}
            value={database}
            onChange={onDatabaseChange}
            disabled={submitting}
            defaultSuffix={t("defaultSuffix")}
            placeholder={t("selectDatabase")}
            searchPlaceholder={t("searchDatabase")}
            emptyText={t("noDatabase")}
          />
          <p className="text-xs text-muted-foreground">
            {t("targetDatabaseHint")}
          </p>
        </>
      )}
      <Label htmlFor="restore-backup-picker">{t("selectBackupLabel")}</Label>
      <div className="flex flex-col sm:flex-row gap-2">
        <Combobox
          autoHighlight
          items={sourceBackups}
          value={backup ?? null}
          onValueChange={(b) => {
            if (b) setValue(b.name);
          }}
          itemToStringLabel={(b) => b.name}
          itemToStringValue={(b) => b.name}
          disabled={submitting || loadingBackups}
        >
          <ComboboxTrigger
            render={
              <Button
                id="restore-backup-picker"
                variant="outline"
                className="flex-1 justify-between font-normal"
              />
            }
          >
            <ComboboxValue>
              {(b: Backup | null) =>
                loadingBackups ? (
                  <span className="text-muted-foreground">
                    {t("loadingBackups")}
                  </span>
                ) : b ? (
                  <span className="truncate font-mono text-sm">{b.name}</span>
                ) : (
                  <span className="text-muted-foreground">
                    {t("selectBackup")}
                  </span>
                )
              }
            </ComboboxValue>
          </ComboboxTrigger>
          <ComboboxContent>
            <ComboboxInput
              showTrigger={false}
              placeholder={t("searchBackup")}
            />
            <ComboboxEmpty>{t("noBackup")}</ComboboxEmpty>
            <ComboboxList>
              {(b: Backup) => (
                <ComboboxItem key={b.name} value={b}>
                  <span className="truncate font-mono text-sm">{b.name}</span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Button
          variant="destructive"
          disabled={!backup || submitting || !canRunOps}
          onClick={onRestore}
          className="shrink-0"
        >
          <RotateCcw className="size-4" />
          {submitting ? t("queuing") : t("restore")}
        </Button>
      </div>
      {backup && (
        <p className="text-xs text-muted-foreground">
          {t("backupSize", {
            sizeMb: (backup.size / 1_024 / 1_024).toFixed(2),
            sizeBytes: backup.size.toLocaleString(),
          })}
        </p>
      )}
      {isDefaultDatabase && (
        <div className="flex items-start gap-2 mt-1">
          <Checkbox
            id="restore-restart-backend"
            checked={restartBackend}
            onCheckedChange={(checked) => setRestartBackend(checked === true)}
            disabled={submitting}
            className="mt-0.5"
          />
          <Label
            htmlFor="restore-restart-backend"
            className="text-sm font-normal cursor-pointer"
          >
            <span className="flex flex-col gap-0.5">
              <span>{t("restartBackendLabel")}</span>
              <span className="text-xs text-muted-foreground">
                {t("restartBackendHint", {
                  backendName: backendService(environment).serviceName,
                })}
              </span>
            </span>
          </Label>
        </div>
      )}
      <LiveRunDialog
        runId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
        title={t("title")}
        onRetry={runRestore}
        description={
          <>
            <code className="font-mono text-sm">{database}</code>
            {backup && (
              <>
                <span>·</span>
                <code className="font-mono text-sm">{backup.name}</code>
              </>
            )}
          </>
        }
      />
    </div>
  );
}
