import { Database, FileArchive } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { DatabasePicker } from "@/components/database-picker";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import { dbService } from "@/lib/services";
import { createDatabaseBackup } from "@/web/api/backups";
import type { DatabaseEntry } from "@/web/api/databases";
import type { EnvironmentWithServers } from "@/web/api/environments";

// Matches the marker emitted by lib/jobs/processor.ts after a successful dump.
// Kept here as a single source of truth for the parser — if the marker text
// ever changes in the worker, update both sides.
const FILENAME_MARKER = /✓ Backup file created:\s*(.+?)\s*$/m;

function extractFilename(output: string): string | null {
  const match = output.match(FILENAME_MARKER);
  return match?.[1] ?? null;
}

// The "Run backup" button. It opens a small dialog for the target database and
// compression (defaults: the environment's database, compressed); confirming
// there queues the backup and streams the run.
export function BackupDatabase({
  environment,
  databases,
}: {
  environment: EnvironmentWithServers;
  databases: DatabaseEntry[];
}) {
  const t = useTranslations("backupDb");
  const tCommon = useTranslations("common");
  const canRunOps = useProjectCan({ database: ["backup"] });
  const router = useRouter();
  const dbSvc = dbService(environment);
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [lastFilename, setLastFilename] = React.useState<string | null>(null);
  const [compress, setCompress] = React.useState(true);
  const [database, setDatabase] = React.useState(dbSvc.dbName ?? "");
  const [submitting, startTransition] = React.useTransition();

  const runBackup = React.useCallback(() => {
    startTransition(async () => {
      try {
        const { runId } = await createDatabaseBackup(environment.id, {
          compress,
          database,
        });
        setOptionsOpen(false);
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
  }, [environment, compress, database, t, tCommon]);

  async function onTaskSuccess(snapshot: { output: string }) {
    // The run finished out of band, so no mutation response invalidated the
    // backup listing (a remote probe with a 30s staleTime): refetch it now so
    // the just-created file shows up.
    router.refresh({ includeRemote: true });
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
    <>
      <Button onClick={() => setOptionsOpen(true)} disabled={!canRunOps}>
        <Database className="size-4" />
        {t("runBackup")}
      </Button>
      <Dialog open={optionsOpen} onOpenChange={setOptionsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("targetDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="backup-database-picker">{t("databaseLabel")}</Label>
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
            <p className="text-xs text-muted-foreground">{t("databaseHint")}</p>
          </div>
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
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOptionsOpen(false)}
              disabled={submitting}
            >
              {tCommon("cancel")}
            </Button>
            <Button onClick={runBackup} disabled={submitting || !database}>
              <Database className="size-4" />
              {submitting ? t("queuing") : t("confirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    </>
  );
}
