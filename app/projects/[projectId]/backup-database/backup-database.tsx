"use client";

import { createDatabaseBackup } from "@/actions/backups";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import type { ProjectWithServers } from "@/lib/db/schema";

export function BackupDatabase({
  project,
}: {
  project: ProjectWithServers;
}) {
  const dialog = useDialog();

  return (
    <Button
      className="ml-auto"
      onClick={async () => {
        if (
          await dialog.confirm({
            title: "Backup Database",
            description: `Are you sure you want to create a backup for database: ${project.dbName}?`,
            confirmText: "Backup",
            cancelText: "Cancel",
          })
        ) {
          createDatabaseBackup(project);
          dialog.alert({
            title: "Backup Created",
            description: `A backup for database: ${project.dbName} has been created successfully.`,
            confirmText: "OK",
          });
        }
      }}
    >
      Backup
    </Button>
  );
}
