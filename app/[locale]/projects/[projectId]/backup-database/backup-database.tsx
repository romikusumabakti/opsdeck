"use client";

import { Database } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createDatabaseBackup } from "@/actions/backups";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import type { ProjectWithServers } from "@/lib/db/schema";

export function BackupDatabase({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("backupDb");
  const tCommon = useTranslations("common");
  const dialog = useDialog();

  return (
    <Button
      onClick={async () => {
        const ok = await dialog.confirm({
          title: t("confirmTitle"),
          description: t("confirmDescription", { dbName: project.dbName }),
          confirmText: t("confirmButton"),
          cancelText: tCommon("cancel"),
        });
        if (!ok) return;
        await createDatabaseBackup(project);
        toast.success(t("successTitle"), {
          description: t("successDescription", { dbName: project.dbName }),
        });
      }}
    >
      <Database className="size-4" />
      {t("button")}
    </Button>
  );
}
