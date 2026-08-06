"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  FolderOpen,
  Pencil,
  Plus,
  Server as ServerIcon,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { bulkDeleteServers, deleteServer } from "@/actions/servers";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { Server } from "@/lib/db/schema";

export function ServersClient({ servers }: { servers: Server[] }) {
  const t = useTranslations("servers");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  // Optimistic removal: drop the row(s) from the table immediately so the user
  // sees the result of their click. React rolls back automatically if the
  // server action throws or the parent revalidation produces a different list.
  const [optimisticServers, removeOptimistic] = useOptimistic<
    Server[],
    string[]
  >(servers, (state, idsToRemove) =>
    state.filter((s) => !idsToRemove.includes(s.id))
  );

  const onDelete = React.useCallback(
    async (server: Server) => {
      const ok = await dialog.confirmTyping({
        title: t("deleteTitle"),
        description: t("deleteDescription", {
          name: server.name,
          host: server.host,
        }),
        phrase: server.name,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        removeOptimistic([server.id]);
        const result = await deleteServer(server.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("deletedSuccess"));
      });
    },
    [dialog, t, tCommon, removeOptimistic]
  );

  const onBulkDelete = React.useCallback(
    async (ids: string[], clearSelection: () => void) => {
      const ok = await dialog.confirm({
        title: t("bulkDeleteTitle", { count: ids.length }),
        description: t("bulkDeleteDescription"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        // Optimistically remove only the rows that aren't in-use; we don't
        // know which those are yet, so drop them all and let the server
        // result + revalidation restore any FK-blocked rows on next render.
        removeOptimistic(ids);
        clearSelection();
        const result = await bulkDeleteServers(ids);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        if (result.failed.length === 0) {
          toast.success(t("bulkDeletedSuccess", { count: result.deleted }));
        } else {
          const failedNames = result.failed
            .map((f) => servers.find((s) => s.id === f.id)?.name ?? f.id)
            .join(", ");
          toast.warning(
            t("bulkDeletedPartial", {
              deleted: result.deleted,
              failed: result.failed.length,
            }),
            { description: failedNames }
          );
        }
      });
    },
    [dialog, t, tCommon, removeOptimistic, servers]
  );

  const columns = React.useMemo<ColumnDef<Server>[]>(
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
        accessorKey: "host",
        meta: { label: t("colHost") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colHost")} />
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.getValue("host")}</span>
        ),
      },
      {
        accessorKey: "username",
        meta: { label: t("colUsername") },
        header: t("colUsername"),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.getValue("username")}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        meta: {
          headClassName: "w-32",
          cellClassName: "w-32",
        },
        cell: ({ row }) => (
          <ServerActions
            server={row.original}
            disabled={isPending}
            browseLabel={t("browseFiles")}
            editLabel={tCommon("edit")}
            deleteLabel={tCommon("delete")}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [t, tCommon, isPending, onDelete]
  );

  const renderCard = React.useCallback(
    (server: Server) => (
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium truncate">{server.name}</span>
          <span className="font-mono text-xs text-muted-foreground truncate">
            {server.host}
          </span>
          <span className="font-mono text-xs text-muted-foreground truncate">
            {server.username}
          </span>
        </div>
        <ServerActions
          server={server}
          disabled={isPending}
          browseLabel={t("browseFiles")}
          editLabel={tCommon("edit")}
          deleteLabel={tCommon("delete")}
          onDelete={() => onDelete(server)}
        />
      </div>
    ),
    [t, tCommon, isPending, onDelete]
  );

  if (optimisticServers.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={ServerIcon}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button render={<Link href="/servers/new" />}>
              <Plus className="size-4" />
              {t("addServer")}
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
      data={optimisticServers}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      getRowId={(row) => row.id}
      urlKey="srv"
      renderCard={renderCard}
      bulkActions={(ids, clearSelection) => (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onBulkDelete(ids, clearSelection)}
          disabled={isPending}
        >
          <Trash2 className="size-4" />
          {t("bulkDelete")}
        </Button>
      )}
    />
  );
}

// Actions are laid out inline instead of behind a kebab menu so every action is
// one click away. Rows are not clickable; navigation happens only through these
// action controls.
function ServerActions({
  server,
  disabled,
  browseLabel,
  editLabel,
  deleteLabel,
  onDelete,
}: {
  server: Server;
  disabled: boolean;
  browseLabel: string;
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
        render={<Link href={`/servers/${server.id}/files`} />}
      >
        <FolderOpen className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={editLabel}
        title={editLabel}
        disabled={disabled}
        render={<Link href={`/servers/${server.id}`} />}
      >
        <Pencil className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={deleteLabel}
        title={deleteLabel}
        disabled={disabled}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
