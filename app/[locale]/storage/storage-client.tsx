"use client";

import type { ColumnDef } from "@tanstack/react-table";
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
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Link, useRouter } from "@/i18n/navigation";
import type { SafeS3Connection } from "@/lib/db/schema";

export function StorageClient({
  connections,
}: {
  connections: SafeS3Connection[];
}) {
  const t = useTranslations("storage");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
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

  const columns = React.useMemo<ColumnDef<SafeS3Connection>[]>(
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
        meta: { headClassName: "w-12", cellClassName: "w-12" },
        cell: ({ row }) => (
          <ConnectionActions
            disabled={isPending}
            menuLabel={tCommon("actions")}
            triggerLabel={tCommon("openMenu")}
            browseLabel={t("browse")}
            editLabel={tCommon("edit")}
            deleteLabel={tCommon("delete")}
            onBrowse={() => router.push(`/storage/${row.original.id}/files`)}
            onEdit={() => router.push(`/storage/${row.original.id}`)}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [t, tCommon, isPending, router, onDelete]
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
      onRowClick={(row) => router.push(`/storage/${row.id}/files`)}
    />
  );
}

function ConnectionActions({
  disabled,
  menuLabel,
  triggerLabel,
  browseLabel,
  editLabel,
  deleteLabel,
  onBrowse,
  onEdit,
  onDelete,
}: {
  disabled: boolean;
  menuLabel: string;
  triggerLabel: string;
  browseLabel: string;
  editLabel: string;
  deleteLabel: string;
  onBrowse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={triggerLabel}
            disabled={disabled}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
        <DropdownMenuItem onClick={onBrowse}>
          <FolderOpen className="size-4" />
          {browseLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
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
  );
}
