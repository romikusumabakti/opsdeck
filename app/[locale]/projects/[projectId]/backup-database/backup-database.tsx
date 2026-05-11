"use client";

import { Database } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { createDatabaseBackup } from "@/actions/backups";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Button } from "@/components/ui/button";
import type { ProjectWithServers } from "@/lib/db/schema";

export function BackupDatabase({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("backupDb");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [submitting, startTransition] = React.useTransition();

  async function onClick() {
    const ok = await dialog.confirm({
      title: t("confirmTitle"),
      description: t("confirmDescription", { dbName: project.dbName }),
      confirmText: t("confirmButton"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    startTransition(async () => {
      try {
        const { taskId } = await createDatabaseBackup(project);
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
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      <div className="flex justify-end">
        <Button onClick={onClick} disabled={submitting}>
          <Database className="size-4" />
          {submitting ? t("queuing") : t("button")}
        </Button>
      </div>
      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
        title={t("title")}
        description={
          <code className="font-mono text-xs">{project.dbName}</code>
        }
      />
    </div>
  );
}
