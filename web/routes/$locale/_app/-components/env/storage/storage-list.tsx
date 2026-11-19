import {
  Eye,
  FolderOpen,
  HardDrive,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import {
  deleteEnvironmentStorage,
  type EnvironmentStorageRow,
  testEnvironmentStorage,
} from "@/web/api/environment-storage";
import { reportError } from "../../admin/instance/report-error";

/**
 * An environment's storage connections. Anyone who can see the environment
 * sees the list; changing a connection needs `canManage` (environment
 * update) and browsing its files needs `canBrowse` (variable read). The
 * server enforces both again.
 */
export function StorageList({
  environmentId,
  basePath,
  connections,
  canManage,
  canBrowse,
}: {
  environmentId: string;
  /** `/KEY/slug/storage`. */
  basePath: string;
  connections: EnvironmentStorageRow[];
  canManage: boolean;
  canBrowse: boolean;
}) {
  const t = useTranslations("storage");
  const tCommon = useTranslations("common");
  const tForm = useTranslations("s3Form");
  const tActions = useTranslations("actionErrors");
  const dialog = useDialog();

  if (connections.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={HardDrive}
          title={t("emptyTitle")}
          description={canManage ? t("empty") : t("emptyReadOnly")}
          action={
            canManage ? (
              <Button
                nativeButton={false}
                render={<Link href={`${basePath}/new`} />}
              >
                <Plus className="size-4" />
                {t("addConnection")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  async function onTest(connection: EnvironmentStorageRow) {
    try {
      const result = await testEnvironmentStorage(environmentId, {
        endpoint: connection.endpoint,
        region: connection.region,
        bucket: connection.bucket,
        accessKeyId: connection.accessKeyId,
        forcePathStyle: connection.forcePathStyle,
        keyPrefix: connection.keyPrefix,
        connectionId: connection.id,
      });
      if (result.ok) toast.success(tForm("testSuccess"));
      else toast.error(`${tForm("testFailed")}: ${result.message}`);
    } catch (error) {
      reportError(error);
    }
  }

  async function onDelete(connection: EnvironmentStorageRow) {
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
      await deleteEnvironmentStorage(environmentId, connection.id);
      toast.success(tActions("s3Deleted"));
    } catch (error) {
      reportError(error);
    }
  }

  function actionsOf(connection: EnvironmentStorageRow) {
    const items: RowAction[] = [
      {
        label: canManage ? tCommon("edit") : tCommon("view"),
        icon: canManage ? Pencil : Eye,
        href: `${basePath}/${connection.id}`,
      },
    ];
    if (canManage) {
      items.push(
        {
          label: tForm("testConnection"),
          icon: Zap,
          onSelect: () => void onTest(connection),
        },
        {
          label: tCommon("delete"),
          icon: Trash2,
          destructive: true,
          onSelect: () => void onDelete(connection),
        }
      );
    }
    return (
      <RowActions
        label={tCommon("openMenu")}
        primary={
          canBrowse
            ? {
                label: t("browse"),
                icon: FolderOpen,
                href: `${basePath}/${connection.id}/files`,
              }
            : undefined
        }
        items={items}
      />
    );
  }

  return (
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
              <TableCell className="font-medium">{connection.name}</TableCell>
              <TableCell className="font-mono text-sm">
                {connection.endpoint}
              </TableCell>
              <TableCell className="font-mono text-sm text-muted-foreground">
                {connection.bucket}
                {connection.keyPrefix ? `/${connection.keyPrefix}` : ""}
              </TableCell>
              <TableCell>
                {/* The instance backup bucket belongs to Admin › Instance:
                    nothing here opens or changes it. */}
                {connection.isBackupDestination ? (
                  <Badge variant="outline">{t("instanceBackups")}</Badge>
                ) : (
                  actionsOf(connection)
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
