"use client";

import { useTranslations } from "next-intl";
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
      className="ml-auto"
      onClick={async () => {
        const ok = await dialog.confirm({
          title: t("confirmTitle"),
          description: t("confirmDescription", { dbName: project.dbName }),
          confirmText: t("confirmButton"),
          cancelText: tCommon("cancel"),
        });
        if (!ok) return;
        createDatabaseBackup(project);
        dialog.alert({
          title: t("successTitle"),
          description: t("successDescription", { dbName: project.dbName }),
          confirmText: t("successButton"),
        });
      }}
    >
      {t("button")}
    </Button>
  );
}
