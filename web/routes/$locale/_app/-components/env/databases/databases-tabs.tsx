import {
  AlertTriangle,
  Database,
  DatabaseBackup,
  DatabaseZap,
} from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dbService } from "@/lib/services";
import type { Backup } from "@/lib/types";
import type { DatabaseEntry } from "@/web/api/databases";
import type {
  EnvironmentListItem,
  EnvironmentWithServers,
} from "@/web/api/environments";
import { RestoreDatabase } from "../restore-database";
import { BackupList } from "./backup-list";
import { ManageDatabases } from "./manage-databases";

export function DatabasesTabs({
  environment,
  databases,
  backups,
  allProjects,
  listError,
  backupListError,
  defaultTab = "backup",
  canBackup,
  canRestore,
}: {
  environment: EnvironmentWithServers;
  databases: DatabaseEntry[];
  backups: Backup[];
  allProjects: EnvironmentListItem[];
  listError: string | null;
  backupListError: string | null;
  defaultTab?: "manage" | "backup" | "restore";
  // The Backup tab (the list) shows for either permission; "Run backup" needs
  // database:backup and the Restore tab / row action database:restore.
  canBackup: boolean;
  canRestore: boolean;
}) {
  const canListBackups = canBackup || canRestore;
  const t = useTranslations("databases");
  const tRestore = useTranslations("restoreDb");

  // Other projects of the same DB engine — the valid sources for a cross-environment
  // restore (the worker reads them in place when on the same server, otherwise
  // stages the file across hosts). When any exist, the restore tab stays
  // reachable even with no local backups (a source may have some). `dbType` is
  // joined into the environment list query, so this needs no per-row lookup.
  const dbType = dbService(environment).dbType;
  const sourceEnvironments = allProjects.filter(
    (p) => p.id !== environment.id && p.dbType === dbType
  );

  type TabValue = "manage" | "backup" | "restore";
  const [tab, setTab] = React.useState<TabValue>(defaultTab);
  // Set by a backup row's Restore action; the Restore tab opens with that file
  // selected. Cleared when the user picks a tab themselves.
  const [restoreBackup, setRestoreBackup] = React.useState<string>();

  function onRestoreRow(name: string) {
    setRestoreBackup(name);
    setTab("restore");
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        setRestoreBackup(undefined);
        setTab(next as TabValue);
      }}
      className="flex flex-1 min-h-0 flex-col gap-4"
    >
      <TabsList className="w-full shrink-0">
        {canListBackups ? (
          <TabsTrigger value="backup">
            <Database className="size-4" />
            {t("backupTab")}
          </TabsTrigger>
        ) : null}
        {canRestore ? (
          <TabsTrigger value="restore">
            <DatabaseBackup className="size-4" />
            {t("restoreTab")}
          </TabsTrigger>
        ) : null}
        <TabsTrigger value="manage">
          <DatabaseZap className="size-4" />
          {t("manageTab")}
        </TabsTrigger>
      </TabsList>

      {canListBackups ? (
        <TabsContent
          value="backup"
          className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto"
        >
          {backupListError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <p>{backupListError}</p>
            </div>
          ) : null}
          <BackupList
            environment={environment}
            databases={databases}
            backups={backups}
            canBackup={canBackup}
            canRestore={canRestore}
            onRestore={onRestoreRow}
          />
        </TabsContent>
      ) : null}

      {canRestore ? (
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
          ) : backups.length === 0 && sourceEnvironments.length === 0 ? (
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
                environment={environment}
                backups={backups}
                databases={databases}
                key={restoreBackup}
                initialBackup={restoreBackup}
                sourceEnvironments={sourceEnvironments}
              />
            </>
          )}
        </TabsContent>
      ) : null}

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
        <ManageDatabases environment={environment} databases={databases} />
      </TabsContent>
    </Tabs>
  );
}
