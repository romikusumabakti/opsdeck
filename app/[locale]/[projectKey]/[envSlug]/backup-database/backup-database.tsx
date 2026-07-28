"use client";

import { ChevronDown, Database, FileArchive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { createDatabaseBackup, revalidateBackupList } from "@/actions/backups";
import type { DatabaseEntry } from "@/actions/databases";
import { CopyButton } from "@/components/copy-button";
import { DatabasePicker } from "@/components/database-picker";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useCanRunOps } from "@/components/ops-capability";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { dbService } from "@/lib/services";
import { cn } from "@/lib/utils";

// Matches the marker emitted by lib/jobs/processor.ts after a successful dump.
// Kept here as a single source of truth for the parser — if the marker text
// ever changes in the worker, update both sides.
const FILENAME_MARKER = /✓ Backup file created:\s*(.+?)\s*$/m;

function extractFilename(output: string): string | null {
  const match = output.match(FILENAME_MARKER);
  return match ? match[1] : null;
}

export function BackupDatabase({
  project,
  databases,
  fixedDatabase,
}: {
  project: SafeEnvironmentWithServers;
  databases: DatabaseEntry[];
  // When set (e.g. the Databases row action), this database is the fixed
  // source and the in-panel picker is hidden.
  fixedDatabase?: string;
}) {
  const t = useTranslations("backupDb");
  const tCommon = useTranslations("common");
  const tDash = useTranslations("dashboard");
  const canRunOps = useCanRunOps();
  const dialog = useDialog();
  const router = useRouter();
  const dbSvc = dbService(project);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [lastFilename, setLastFilename] = React.useState<string | null>(null);
  const [compress, setCompress] = React.useState(true);
  // Database target + compression stay hidden until opened so the common path
  // is a single "Backup" click on the default DB.
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [database, setDatabase] = React.useState(
    fixedDatabase ?? dbSvc.dbName ?? ""
  );
  const [submitting, startTransition] = React.useTransition();

  const runBackup = React.useCallback(() => {
    startTransition(async () => {
      try {
        const { runId } = await createDatabaseBackup(project.id, {
          compress,
          database,
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
  }, [project, compress, database, t, tCommon]);

  async function onClick() {
    const ok = await dialog.confirm({
      title: t("confirmTitle"),
      description: t("confirmDescription", { dbName: database }),
      confirmText: t("confirmButton"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    runBackup();
  }

  async function onTaskSuccess(snapshot: { output: string }) {
    // Drop the `unstable_cache` backup listing first, then refresh: `router.refresh()`
    // alone only re-runs the server component, which still reads the stale cached
    // list — so the just-created file wouldn't appear until the 30s revalidate.
    await revalidateBackupList(project.id);
    router.refresh();
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

  const compressField = (
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
  );

  return (
    <div className="flex flex-col gap-4 w-full">
      {fixedDatabase ? (
        compressField
      ) : (
        <>
          {/* Compact labelled context. The target DB is dropped once Advanced
              is open, where the picker surfaces and edits it. */}
          <dl className="flex flex-wrap gap-x-8 gap-y-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {tDash("dbType")}
              </dt>
              <dd>
                <Badge variant="secondary">
                  {tDash(`dbTypes.${dbSvc.dbType ?? ""}`)}
                </Badge>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {tDash("server")}
              </dt>
              <dd className="truncate">{dbSvc.server.name}</dd>
            </div>
            {!advancedOpen && (
              <div className="flex flex-col gap-1">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("databaseLabel")}
                </dt>
                <dd className="flex items-center gap-2">
                  <code className="font-mono text-sm">{database}</code>
                  {database === (dbSvc.dbName ?? "") && (
                    <span className="text-xs text-muted-foreground">
                      {t("defaultSuffix")}
                    </span>
                  )}
                </dd>
              </div>
            )}
          </dl>
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
              <div className="flex flex-col gap-2">
                <Label htmlFor="backup-database-picker">
                  {t("databaseLabel")}
                </Label>
                <DatabasePicker
                  id="backup-database-picker"
                  databases={databases}
                  value={database}
                  onChange={setDatabase}
                  disabled={submitting}
                  defaultSuffix={t("defaultSuffix")}
                  placeholder={t("selectDatabase")}
                  searchPlaceholder={t("searchDatabase")}
                  emptyText={t("noDatabase")}
                />
                <p className="text-xs text-muted-foreground">
                  {t("databaseHint")}
                </p>
              </div>
              {compressField}
            </>
          )}
        </>
      )}
      <div className="flex justify-end">
        <Button onClick={onClick} disabled={submitting || !canRunOps}>
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
      <LiveRunDialog
        runId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
        title={t("title")}
        description={<code className="font-mono text-xs">{database}</code>}
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
