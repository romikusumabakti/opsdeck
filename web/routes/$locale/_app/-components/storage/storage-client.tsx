import { Eye, FolderOpen, HardDrive, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import { Link } from "@/i18n/navigation";
import {
  deleteS3Connection,
  type S3ConnectionRow as SafeS3Connection,
} from "@/web/api/s3-connections";

// What the caller may do beyond listing (storage:read), from the page.
export type StorageCapabilities = { manage: boolean; files: boolean };

export function StorageClient({
  connections,
  can,
}: {
  connections: SafeS3Connection[];
  can: StorageCapabilities;
}) {
  const t = useTranslations("storage");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const [optimistic, removeOptimistic] = useOptimistic<
    SafeS3Connection[],
    string[]
  >(connections, (state, ids) => state.filter((c) => !ids.includes(c.id)));

  const onDelete = React.useCallback(
    async (conn: SafeS3Connection) => {
      const ok = await dialog.confirmTyping({
        title: t("deleteTitle"),
        description: t("deleteDescription", { name: conn.name }),
        phrase: conn.name,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        removeOptimistic([conn.id]);
        const result = await deleteS3Connection(conn.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
      });
    },
    [dialog, t, tCommon, removeOptimistic]
  );

  const columns = React.useMemo<DataTableColumnDef<SafeS3Connection>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colName") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colName")} />
        ),
        cell: ({ row }) => (
          <span className="font-medium">{row.getValue("name")}</span>
        ),
      },
      {
        accessorKey: "endpoint",
        meta: { label: t("colEndpoint") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colEndpoint")} />
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.getValue("endpoint")}</span>
        ),
      },
      {
        accessorKey: "bucket",
        meta: { label: t("colBucket") },
        header: t("colBucket"),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.getValue("bucket")}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-24", cellClassName: "w-24" },
        cell: ({ row }) => (
          <ConnectionActions
            connection={row.original}
            can={can}
            disabled={isPending}
            browseLabel={t("browse")}
            menuLabel={tCommon("openMenu")}
            editLabel={can.manage ? tCommon("edit") : tCommon("view")}
            deleteLabel={tCommon("delete")}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [t, tCommon, isPending, onDelete, can]
  );

  if (optimistic.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={HardDrive}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            can.manage ? (
              <Button
                nativeButton={false}
                render={<Link href="/storage/new" />}
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

  return (
    <DataTable
      fillHeight
      columns={columns}
      data={optimistic}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      getRowId={(row) => row.id}
      urlKey="s3"
    />
  );
}

// Browsing is the row's primary action, so it stays a button; edit and delete
// live behind the ⋯ menu, which keeps a destructive control from sitting one
// stray click away from it. Rows are not clickable; navigation happens only
// through these action controls.
function ConnectionActions({
  connection,
  can,
  disabled,
  browseLabel,
  menuLabel,
  editLabel,
  deleteLabel,
  onDelete,
}: {
  connection: SafeS3Connection;
  can: StorageCapabilities;
  disabled: boolean;
  browseLabel: string;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
  onDelete: () => void;
}) {
  const items: RowAction[] = [
    // The detail page is read-only without storage:manage.
    {
      label: editLabel,
      icon: can.manage ? Pencil : Eye,
      href: `/storage/${connection.id}`,
    },
  ];
  if (can.manage) {
    items.push({
      label: deleteLabel,
      icon: Trash2,
      destructive: true,
      onSelect: onDelete,
    });
  }
  return (
    <RowActions
      label={menuLabel}
      disabled={disabled}
      primary={
        can.files
          ? {
              label: browseLabel,
              icon: FolderOpen,
              href: `/storage/${connection.id}/files`,
            }
          : undefined
      }
      items={items}
    />
  );
}
