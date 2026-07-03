"use client";

import {
  AlertTriangle,
  Database,
  DatabaseBackup,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  createDatabase,
  type DatabaseEntry,
  dropDatabase,
  renameDatabase,
} from "@/actions/databases";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import type { Backup } from "@/lib/types";
import { BackupDatabase } from "../backup-database/backup-database";
import { RestoreDatabase } from "../restore-database/restore-database";

export function ManageDatabases({
  project,
  databases,
  backups,
  backupListError,
}: {
  project: SafeProjectWithServers;
  databases: DatabaseEntry[];
  backups: Backup[];
  backupListError?: string | null;
}) {
  const t = useTranslations("databases");
  const tCommon = useTranslations("common");
  const tRestore = useTranslations("restoreDb");
  const dialog = useDialog();
  const router = useRouter();
  const [newName, setNewName] = React.useState("");
  const [backupFor, setBackupFor] = React.useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskTarget, setTaskTarget] = React.useState("");
  const [submitting, startTransition] = React.useTransition();

  const trimmed = newName.trim();

  function onCreate() {
    if (!trimmed) return;
    startTransition(async () => {
      try {
        const { taskId } = await createDatabase(project.id, {
          database: trimmed,
        });
        setTaskTitle(t("createTaskTitle"));
        setTaskTarget(trimmed);
        setActiveTaskId(taskId);
        setNewName("");
        toast.success(t("createQueuedTitle"), {
          description: t("createQueuedDescription", { dbName: trimmed }),
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      }
    });
  }

  function onRename(name: string) {
    void (async () => {
      const next = await dialog.prompt({
        title: t("renameTitle"),
        description: t("renameDescription", { dbName: name }),
        confirmText: t("rename"),
        cancelText: tCommon("cancel"),
        defaultValue: name,
        placeholder: t("renamePlaceholder"),
      });
      const target = next?.trim();
      if (!target || target === name) return;
      startTransition(async () => {
        try {
          const { taskId } = await renameDatabase(project.id, {
            from: name,
            to: target,
          });
          setTaskTitle(t("renameTaskTitle"));
          setTaskTarget(`${name} → ${target}`);
          setActiveTaskId(taskId);
          toast.success(t("renameQueuedTitle"), {
            description: t("renameQueuedDescription", {
              from: name,
              to: target,
            }),
          });
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : tCommon("errorGeneric")
          );
        }
      });
    })();
  }

  function onDrop(name: string) {
    void (async () => {
      const ok = await dialog.confirm({
        title: t("dropConfirmTitle"),
        description: t("dropConfirmDescription", { dbName: name }),
        confirmText: t("drop"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        try {
          const { taskId } = await dropDatabase(project.id, { database: name });
          setTaskTitle(t("dropTaskTitle"));
          setTaskTarget(name);
          setActiveTaskId(taskId);
          toast.success(t("dropQueuedTitle"), {
            description: t("dropQueuedDescription", { dbName: name }),
          });
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : tCommon("errorGeneric")
          );
        }
      });
    })();
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate();
        }}
      >
        <Label htmlFor="new-database-name">{t("createLabel")}</Label>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            id="new-database-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("createPlaceholder")}
            disabled={submitting}
            className="flex-1 font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={!trimmed || submitting}>
            <Plus className="size-4" />
            {submitting ? t("queuing") : t("create")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("createHint")}</p>
      </form>

      <div className="flex flex-col gap-2">
        <Label>{t("existingLabel")}</Label>
        <ul className="flex flex-col divide-y rounded-md border">
          {databases.map((d) => (
            <li
              key={d.name}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <Database className="size-4 shrink-0 text-muted-foreground" />
              <code className="font-mono text-xs truncate flex-1 min-w-0">
                {d.name}
              </code>
              {d.isDefault && (
                <Badge variant="secondary" className="shrink-0">
                  {t("defaultBadge")}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                disabled={d.isDefault || submitting}
                onClick={() => onRename(d.name)}
                title={
                  d.isDefault ? t("cannotRenameDefault") : t("renameTitle")
                }
                aria-label={t("renameTitle")}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                disabled={submitting}
                onClick={() => setBackupFor(d.name)}
                title={t("backupTitle")}
                aria-label={t("backupTitle")}
              >
                <DatabaseBackup className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-destructive hover:text-destructive"
                disabled={d.isDefault || submitting}
                onClick={() => onDrop(d.name)}
                title={d.isDefault ? t("cannotDropDefault") : t("dropTitle")}
                aria-label={t("dropTitle")}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("restoreSectionLabel")}</Label>
        <p className="text-sm text-muted-foreground">
          {tRestore("pickerDescription")}
        </p>
        {backupListError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <p>{backupListError}</p>
          </div>
        ) : backups.length === 0 ? (
          <EmptyState
            icon={DatabaseBackup}
            title={tRestore("backupsNotFound")}
            description={tRestore("backupsNotFoundDescription")}
          />
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <p>{tRestore("dangerNote")}</p>
            </div>
            <RestoreDatabase
              project={project}
              backups={backups}
              databases={databases}
            />
          </>
        )}
      </div>

      <Dialog
        open={backupFor !== null}
        onOpenChange={(open) => {
          if (!open) setBackupFor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backupTitle")}</DialogTitle>
            <DialogDescription>
              <code className="font-mono text-xs">{backupFor}</code>
            </DialogDescription>
          </DialogHeader>
          {backupFor !== null && (
            <BackupDatabase
              key={backupFor}
              project={project}
              databases={databases}
              fixedDatabase={backupFor}
            />
          )}
        </DialogContent>
      </Dialog>

      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) {
            setActiveTaskId(null);
            // Refresh so the database list reflects the create/drop result.
            router.refresh();
          }
        }}
        title={taskTitle}
        description={<code className="font-mono text-xs">{taskTarget}</code>}
      />
    </div>
  );
}
