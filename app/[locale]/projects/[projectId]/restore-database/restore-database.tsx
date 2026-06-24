"use client";

import { Check, ChevronsUpDown, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { restoreDatabaseBackup } from "@/actions/backups";
import type { DatabaseEntry } from "@/actions/databases";
import { DatabasePicker } from "@/components/database-picker";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import type { Backup } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RestoreDatabase({
  project,
  backups,
  databases,
}: {
  project: SafeProjectWithServers;
  backups: Backup[];
  databases: DatabaseEntry[];
}) {
  const t = useTranslations("restoreDb");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [database, setDatabase] = React.useState(project.dbName);
  const [restartBackend, setRestartBackend] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [submitting, startTransition] = React.useTransition();

  const backup = backups.find((b) => b.name === value);
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
        const { taskId } = await restoreDatabaseBackup(project.id, {
          filename: backup.name,
          restartBackend,
          database,
        });
        setActiveTaskId(taskId);
        toast.success(t("successTitle"), {
          description: t("successDescription", { dbName: database }),
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      }
    });
  }, [backup, project, restartBackend, database, t, tCommon]);

  function onRestore() {
    if (!backup) return;
    void (async () => {
      const ok = await dialog.confirm({
        title: t("confirmTitle"),
        description: t("confirmDescription", {
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
      <p className="text-xs text-muted-foreground">{t("targetDatabaseHint")}</p>
      <Label htmlFor="restore-backup-picker" className="mt-1">
        {t("selectBackupLabel")}
      </Label>
      <div className="flex flex-col sm:flex-row gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id="restore-backup-picker"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="flex-1 justify-between"
            >
              {backup ? (
                <span className="truncate font-mono text-xs">
                  {backup.name}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {t("selectBackup")}
                </span>
              )}
              <ChevronsUpDown className="opacity-50 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[var(--radix-popper-anchor-width)] p-0"
          >
            <Command>
              <CommandInput placeholder={t("searchBackup")} className="h-9" />
              <CommandList>
                <CommandEmpty>{t("noBackup")}</CommandEmpty>
                <CommandGroup>
                  {backups.map((b) => (
                    <CommandItem
                      key={b.name}
                      value={b.name}
                      onSelect={(currentValue) => {
                        setValue(currentValue === value ? "" : currentValue);
                        // Defer close past the click event so Radix Popover's
                        // dismiss + focus-restore doesn't race the same tick
                        // (causes a brief reopen flicker on slower envs).
                        requestAnimationFrame(() => setOpen(false));
                      }}
                    >
                      <span className="truncate font-mono text-xs">
                        {b.name}
                      </span>
                      <Check
                        className={cn(
                          "ml-auto",
                          value === b.name ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          variant="destructive"
          disabled={!backup || submitting}
          onClick={onRestore}
          className="shrink-0"
        >
          <RotateCcw className="size-4" />
          {submitting ? t("queuing") : t("restore")}
        </Button>
      </div>
      {backup &&
        (() => {
          const backupSize = parseInt(backup.size, 10);
          return (
            <p className="text-xs text-muted-foreground">
              {t("backupSize", {
                sizeMb: (backupSize / 1_024 / 1_024).toFixed(2),
                sizeBytes: backupSize.toLocaleString(),
              })}
            </p>
          );
        })()}
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
                  backendName: project.backendServiceName,
                })}
              </span>
            </span>
          </Label>
        </div>
      )}
      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
        title={t("title")}
        onRetry={runRestore}
        description={
          <>
            <code className="font-mono text-xs">{database}</code>
            {backup && (
              <>
                <span>·</span>
                <code className="font-mono text-xs">{backup.name}</code>
              </>
            )}
          </>
        }
      />
    </div>
  );
}
