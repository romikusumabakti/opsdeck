"use client";

import {
  FolderOpen,
  HardDrive,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { deleteS3Connection } from "@/actions/s3-connections";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { SafeS3Connection } from "@/lib/db/schema";

export function StorageClient({
  connections,
}: {
  connections: SafeS3Connection[];
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
            disabled={isPending}
            browseLabel={t("browse")}
            menuLabel={tCommon("openMenu")}
            editLabel={tCommon("edit")}
            deleteLabel={tCommon("delete")}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [t, tCommon, isPending, onDelete]
  );

  if (optimistic.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={HardDrive}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button render={<Link href="/storage/new" />}>
              <Plus className="size-4" />
              {t("addConnection")}
            </Button>
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
  disabled,
  browseLabel,
  menuLabel,
  editLabel,
  deleteLabel,
  onDelete,
}: {
  connection: SafeS3Connection;
  disabled: boolean;
  browseLabel: string;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={browseLabel}
        title={browseLabel}
        disabled={disabled}
        render={<Link href={`/storage/${connection.id}/files`} />}
      >
        <FolderOpen className="size-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={menuLabel}
              title={menuLabel}
              disabled={disabled}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            render={<Link href={`/storage/${connection.id}`} />}
          >
            <Pencil className="size-4" />
            {editLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 className="size-4" />
            {deleteLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
