"use client";

import { AlertTriangle, Database, DatabaseBackup } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DatabaseEntry } from "@/actions/databases";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import type { Backup } from "@/lib/types";
import { BackupDatabase } from "../backup-database/backup-database";
import { RestoreDatabase } from "../restore-database/restore-database";

export function BackupRestoreTabs({
  project,
  databases,
  backups,
  listError,
  defaultTab = "backup",
}: {
  project: SafeProjectWithServers;
  databases: DatabaseEntry[];
  backups: Backup[];
  listError: string | null;
  defaultTab?: "backup" | "restore";
}) {
  const tNav = useTranslations("nav");
  const tBackup = useTranslations("backupDb");
  const tRestore = useTranslations("restoreDb");
  const tDash = useTranslations("dashboard");

  return (
    <Tabs defaultValue={defaultTab} className="gap-4">
      <TabsList className="w-full">
        <TabsTrigger value="backup">
          <Database className="size-4" />
          {tNav("backupDatabase")}
        </TabsTrigger>
        <TabsTrigger value="restore">
          <DatabaseBackup className="size-4" />
          {tNav("restoreDatabase")}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="backup" className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {tBackup("targetDescription")}
        </p>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm rounded-md border bg-muted/30 p-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {tDash("dbType")}
            </dt>
            <dd>
              <Badge variant="secondary">
                {tDash(`dbTypes.${project.dbType}`)}
              </Badge>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {tDash("dbName")}
            </dt>
            <dd>
              <code className="font-mono text-sm">{project.dbName}</code>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {tDash("server")}
            </dt>
            <dd className="truncate">{project.dbServer.name}</dd>
          </div>
        </dl>
        <BackupDatabase project={project} databases={databases} />
        <p className="text-xs text-muted-foreground">{tBackup("infoNote")}</p>
      </TabsContent>

      <TabsContent value="restore" className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {tRestore("pickerDescription")}
        </p>
        {listError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <p>{listError}</p>
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
      </TabsContent>
    </Tabs>
  );
}
