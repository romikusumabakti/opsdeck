"use client";

import { Check, ChevronDown, ChevronsUpDown, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { getBackupList, restoreDatabaseBackup } from "@/actions/backups";
import type { DatabaseEntry } from "@/actions/databases";
import { DatabasePicker } from "@/components/database-picker";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useCanRunOps } from "@/components/ops-capability";
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
import type { Environment, SafeEnvironmentWithServers } from "@/lib/db/schema";
import { backendService, dbService } from "@/lib/services";
import type { Backup } from "@/lib/types";
import { cn } from "@/lib/utils";

export function RestoreDatabase({
  project,
  backups,
  databases,
  sourceProjects,
}: {
  project: SafeEnvironmentWithServers;
  backups: Backup[];
  databases: DatabaseEntry[];
  // Other projects sharing this project's DB location, offered as alternative
  // backup sources. Empty when the project has no compatible siblings.
  sourceProjects: Environment[];
}) {
  const t = useTranslations("restoreDb");
  const tCommon = useTranslations("common");
  const canRunOps = useCanRunOps();
  const dialog = useDialog();
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [database, setDatabase] = React.useState(
    dbService(project).dbName ?? ""
  );
  const [restartBackend, setRestartBackend] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [submitting, startTransition] = React.useTransition();

  // Backup source. Defaults to this project; the picker (shown only when
  // compatible siblings exist) can switch it. Switching re-fetches the chosen
  // project's backup list and clears the selected file.
  const [sourceOpen, setSourceOpen] = React.useState(false);
  // Advanced controls (restore into a non-default DB, or from another project)
  // stay hidden until opened so the common path is a single backup + Restore.
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [sourceProjectId, setSourceProjectId] = React.useState(project.id);
  const [sourceBackups, setSourceBackups] = React.useState<Backup[]>(backups);
  const [loadingBackups, setLoadingBackups] = React.useState(false);

  const isCrossProject = sourceProjectId !== project.id;
  const sourceProject = sourceProjects.find((p) => p.id === sourceProjectId);
  const sourceName = sourceProject?.name ?? project.name;

  function onSourceChange(nextId: string) {
    if (nextId === sourceProjectId) return;
    setSourceProjectId(nextId);
    setValue("");
    if (nextId === project.id) {
      // Reuse the server-rendered list for the current project — no round-trip.
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
        const { runId } = await restoreDatabaseBackup(project.id, {
          filename: backup.name,
          restartBackend,
          database,
          sourceProjectId: isCrossProject ? sourceProjectId : undefined,
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
    project,
    restartBackend,
    database,
    isCrossProject,
    sourceProjectId,
    t,
    tCommon,
  ]);

  function onRestore() {
    if (!backup) return;
    void (async () => {
      const ok = await dialog.confirm({
        title: t("confirmTitle"),
        description: isCrossProject
          ? t("confirmDescriptionCrossProject", {
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
          {sourceProjects.length > 0 && (
            <>
              <Label htmlFor="restore-source-picker">
                {t("sourceProjectLabel")}
              </Label>
              <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      id="restore-source-picker"
                      variant="outline"
                      role="combobox"
                      aria-expanded={sourceOpen}
                      disabled={submitting}
                      className="justify-between"
                    />
                  }
                >
                  <span className="truncate">
                    {sourceName}
                    {!isCrossProject && (
                      <span className="text-muted-foreground">
                        {" "}
                        {t("sourceSelfSuffix")}
                      </span>
                    )}
                  </span>
                  <ChevronsUpDown className="opacity-50 shrink-0" />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popper-anchor-width)] p-0"
                >
                  <Command>
                    <CommandInput
                      placeholder={t("searchProject")}
                      className="h-9"
                    />
                    <CommandList>
                      <CommandEmpty>{t("noProject")}</CommandEmpty>
                      <CommandGroup>
                        {[
                          { id: project.id, name: project.name, self: true },
                          ...sourceProjects.map((p) => ({
                            id: p.id,
                            name: p.name,
                            self: false,
                          })),
                        ].map((p) => (
                          <CommandItem
                            key={p.id}
                            value={`${p.name} ${p.id}`}
                            onSelect={() => {
                              onSourceChange(p.id);
                              requestAnimationFrame(() => setSourceOpen(false));
                            }}
                          >
                            <span className="truncate">
                              {p.name}
                              {p.self && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  {t("sourceSelfSuffix")}
                                </span>
                              )}
                            </span>
                            <Check
                              className={cn(
                                "ml-auto",
                                sourceProjectId === p.id
                                  ? "opacity-100"
                                  : "opacity-0"
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground">
                {t("sourceProjectHint")}
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
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                id="restore-backup-picker"
                variant="outline"
                role="combobox"
                aria-expanded={open}
                disabled={submitting || loadingBackups}
                className="flex-1 justify-between"
              />
            }
          >
            {loadingBackups ? (
              <span className="text-muted-foreground">
                {t("loadingBackups")}
              </span>
            ) : backup ? (
              <span className="truncate font-mono text-xs">{backup.name}</span>
            ) : (
              <span className="text-muted-foreground">{t("selectBackup")}</span>
            )}
            <ChevronsUpDown className="opacity-50 shrink-0" />
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
                  {sourceBackups.map((b) => (
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
          disabled={!backup || submitting || !canRunOps}
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
                  backendName: backendService(project).serviceName,
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
