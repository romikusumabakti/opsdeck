import { HardDrive, Link2, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/components/search-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  assignS3Connection,
  deleteUnassignedS3Connection,
  type S3ConnectionRow,
} from "@/web/api/s3-connections";
import { reportError } from "../instance/report-error";

/**
 * Admin › Storage: connections no environment owns (an environment's deletion
 * leaves its connections here). An admin gives one to an environment, from
 * which its managers take over, or deletes it.
 */
export function UnassignedStorage({
  connections,
  environments,
}: {
  connections: S3ConnectionRow[];
  /** The environments to pick from, labelled "Project / Environment". */
  environments: SearchSelectOption[];
}) {
  const t = useTranslations("adminStorage");
  const tCommon = useTranslations("common");
  const tActions = useTranslations("actionErrors");
  const dialog = useDialog();
  const [assigning, setAssigning] = useState<S3ConnectionRow | null>(null);

  async function onDelete(connection: S3ConnectionRow) {
    const ok = await dialog.confirmTyping({
      title: t("deleteTitle"),
      description: t("deleteDescription", { name: connection.name }),
      phrase: connection.name,
      phraseLabel: tCommon("confirmTypingLabel"),
      placeholder: tCommon("confirmTypingPlaceholder"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    try {
      await deleteUnassignedS3Connection(connection.id);
      toast.success(tActions("s3Deleted"));
    } catch (error) {
      reportError(error);
    }
  }

  if (connections.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={HardDrive}
          title={t("emptyTitle")}
          description={t("empty")}
        />
      </div>
    );
  }

  function actionsOf(connection: S3ConnectionRow) {
    // The instance backup bucket (the legacy connection, or one reaching
    // into the destination) stays Admin › Instance's: neither given to an
    // environment nor deleted here.
    const restricted = connection.isBackupDestination;
    const disabledReason = restricted ? t("backupDestinationHint") : undefined;
    const items: RowAction[] = [
      {
        label: t("assign"),
        icon: Link2,
        onSelect: () => setAssigning(connection),
        disabled: restricted,
        disabledReason,
      },
      {
        label: tCommon("delete"),
        icon: Trash2,
        destructive: true,
        onSelect: () => void onDelete(connection),
        disabled: restricted,
        disabledReason,
      },
    ];
    return <RowActions label={tCommon("openMenu")} items={items} />;
  }

  return (
    <>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colName")}</TableHead>
              <TableHead>{t("colEndpoint")}</TableHead>
              <TableHead>{t("colBucket")}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow key={connection.id}>
                <TableCell className="font-medium">
                  {connection.name}
                  {connection.isBackupDestination && (
                    <Badge variant="outline" className="ms-2">
                      {t("instanceBackups")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {connection.endpoint}
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {connection.bucket}
                  {connection.keyPrefix ? `/${connection.keyPrefix}` : ""}
                </TableCell>
                <TableCell>{actionsOf(connection)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {assigning && (
        <AssignDialog
          key={assigning.id}
          connection={assigning}
          environments={environments}
          onClose={() => setAssigning(null)}
        />
      )}
    </>
  );
}

function AssignDialog({
  connection,
  environments,
  onClose,
}: {
  connection: S3ConnectionRow;
  environments: SearchSelectOption[];
  onClose: () => void;
}) {
  const t = useTranslations("adminStorage");
  const tCommon = useTranslations("common");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit() {
    if (!environmentId) return;
    setPending(true);
    try {
      await assignS3Connection(connection.id, environmentId);
      toast.success(
        t("assigned", {
          name: connection.name,
          environment:
            environments.find((e) => e.value === environmentId)?.label ?? "",
        })
      );
      onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>
              {t("assignTitle", { name: connection.name })}
            </DialogTitle>
            <DialogDescription>{t("assignDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="assign-storage-environment">
              {t("environment")}
            </Label>
            <SearchSelect
              id="assign-storage-environment"
              value={environmentId}
              onChange={setEnvironmentId}
              options={environments}
              placeholder={t("environmentPlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!environmentId || pending}>
              {pending && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {t("assign")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
