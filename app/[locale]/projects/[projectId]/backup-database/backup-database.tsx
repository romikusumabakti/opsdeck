"use client";

import { Database, FileArchive } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { createDatabaseBackup } from "@/actions/backups";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ProjectWithServers } from "@/lib/db/schema";

// Matches the marker emitted by inngest/functions.ts after a successful dump.
// Kept here as a single source of truth for the parser — if the marker text
// ever changes in the worker, update both sides.
const FILENAME_MARKER = /✓ Backup file created:\s*(.+?)\s*$/m;

function extractFilename(output: string): string | null {
  const match = output.match(FILENAME_MARKER);
  return match ? match[1] : null;
}

export function BackupDatabase({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("backupDb");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [lastFilename, setLastFilename] = React.useState<string | null>(null);
  const [compress, setCompress] = React.useState(true);
  const [submitting, startTransition] = React.useTransition();

  const runBackup = React.useCallback(() => {
    startTransition(async () => {
      try {
        const { taskId } = await createDatabaseBackup({ ...project, compress });
        setActiveTaskId(taskId);
        toast.success(t("successTitle"), {
          description: t("successDescription", { dbName: project.dbName }),
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      }
    });
  }, [project, compress, t, tCommon]);

  async function onClick() {
    const ok = await dialog.confirm({
      title: t("confirmTitle"),
      description: t("confirmDescription", { dbName: project.dbName }),
      confirmText: t("confirmButton"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    runBackup();
  }

  function onTaskSuccess(snapshot: { output: string }) {
    const filename = extractFilename(snapshot.output);
    if (!filename) return;
    setLastFilename(filename);
    toast.success(t("createdToast"), {
      description: filename,
      action: {
        label: tCommon("copy"),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(filename);
            toast.success(tCommon("copied"));
          } catch {
            toast.error(tCommon("copyFailed"));
          }
        },
      },
    });
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex items-start gap-2">
        <Checkbox
          id="backup-compress"
          checked={compress}
          onCheckedChange={(checked) => setCompress(checked === true)}
          disabled={submitting}
          className="mt-0.5"
        />
        <Label
          htmlFor="backup-compress"
          className="text-sm font-normal cursor-pointer"
        >
          <span className="flex flex-col gap-0.5">
            <span>{t("compressLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("compressHint")}
            </span>
          </span>
        </Label>
      </div>
      <div className="flex justify-end">
        <Button onClick={onClick} disabled={submitting}>
          <Database className="size-4" />
          {submitting ? t("queuing") : t("button")}
        </Button>
      </div>
      {lastFilename && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <FileArchive className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground shrink-0">
            {t("lastFileLabel")}
          </span>
          <code className="font-mono text-xs truncate flex-1 min-w-0">
            {lastFilename}
          </code>
          <CopyButton value={lastFilename} label={tCommon("copy")} />
        </div>
      )}
      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
        title={t("title")}
        description={
          <code className="font-mono text-xs">{project.dbName}</code>
        }
        onSuccess={onTaskSuccess}
        onRetry={runBackup}
        footer={
          lastFilename && activeTaskId ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <FileArchive className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground shrink-0">
                {t("lastFileLabel")}
              </span>
              <code className="font-mono text-xs truncate flex-1 min-w-0">
                {lastFilename}
              </code>
              <CopyButton value={lastFilename} label={tCommon("copy")} />
            </div>
          ) : null
        }
      />
    </div>
  );
}
