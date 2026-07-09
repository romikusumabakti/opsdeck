"use client";

import {
  AlertTriangle,
  Database,
  DatabaseBackup,
  DatabaseZap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { DatabaseEntry } from "@/actions/databases";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project, SafeProjectWithServers } from "@/lib/db/schema";
import type { Backup } from "@/lib/types";
import { BackupDatabase } from "../backup-database/backup-database";
import { RestoreDatabase } from "../restore-database/restore-database";
import { ManageDatabases } from "./manage-databases";

export function DatabasesTabs({
  project,
  databases,
  backups,
  allProjects,
  listError,
  backupListError,
  defaultTab = "backup",
}: {
  project: SafeProjectWithServers;
  databases: DatabaseEntry[];
  backups: Backup[];
  allProjects: Project[];
  listError: string | null;
  backupListError: string | null;
  defaultTab?: "manage" | "backup" | "restore";
}) {
  const t = useTranslations("databases");
  const tBackup = useTranslations("backupDb");
  const tRestore = useTranslations("restoreDb");

  // Other projects of the same DB engine — the valid sources for a cross-project
  // restore (the worker reads them in place when on the same server, otherwise
  // stages the file across hosts). When any exist, the restore tab stays
  // reachable even with no local backups (a source may have some).
  const sourceProjects = allProjects.filter(
    (p) => p.id !== project.id && p.dbType === project.dbType
  );

  return (
    <Tabs
      defaultValue={defaultTab}
      className="flex flex-1 min-h-0 flex-col gap-4"
    >
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="backup">
          <Database className="size-4" />
          {t("backupTab")}
        </TabsTrigger>
        <TabsTrigger value="restore">
          <DatabaseBackup className="size-4" />
          {t("restoreTab")}
        </TabsTrigger>
        <TabsTrigger value="manage">
          <DatabaseZap className="size-4" />
          {t("manageTab")}
        </TabsTrigger>
      </TabsList>

      <TabsContent
        value="backup"
        className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto"
      >
        <p className="text-sm text-muted-foreground">
          {tBackup("targetDescription")}
        </p>
        <BackupDatabase project={project} databases={databases} />
        <p className="text-xs text-muted-foreground">{tBackup("infoNote")}</p>
      </TabsContent>

      <TabsContent
        value="restore"
        className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto"
      >
        <p className="text-sm text-muted-foreground">
          {tRestore("pickerDescription")}
        </p>
        {backupListError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <p>{backupListError}</p>
          </div>
        ) : backups.length === 0 && sourceProjects.length === 0 ? (
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
              sourceProjects={sourceProjects}
            />
          </>
        )}
      </TabsContent>

      <TabsContent
        value="manage"
        className="flex flex-1 min-h-0 flex-col gap-4"
      >
        {listError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <p>{listError}</p>
          </div>
        )}
        <ManageDatabases project={project} databases={databases} />
      </TabsContent>
    </Tabs>
  );
}
