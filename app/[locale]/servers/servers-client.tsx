"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  MoreHorizontal,
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
import type { Server } from "@/lib/db/schema";

export function ServersClient({ servers }: { servers: Server[] }) {
  const t = useTranslations("servers");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
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
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colName")} />
        ),
        cell: ({ row }) => (
          <span className="font-medium">{row.getValue("name")}</span>
        ),
      },
      {
        accessorKey: "host",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colHost")} />
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.getValue("host")}</span>
        ),
      },
      {
        accessorKey: "username",
        header: t("colUsername"),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.getValue("username")}
          </span>
        ),
      },
      {
        id: "actions",
        meta: {
          headClassName: "w-12",
          cellClassName: "w-12",
        },
        cell: ({ row }) => (
          <ServerActions
            disabled={isPending}
            menuLabel={tCommon("actions")}
            triggerLabel={tCommon("openMenu")}
            editLabel={tCommon("edit")}
            deleteLabel={tCommon("delete")}
            onEdit={() => router.push(`/servers/${row.original.id}`)}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [t, tCommon, isPending, router, onDelete]
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
          disabled={isPending}
          menuLabel={tCommon("actions")}
          triggerLabel={tCommon("openMenu")}
          editLabel={tCommon("edit")}
          deleteLabel={tCommon("delete")}
          onEdit={() => router.push(`/servers/${server.id}`)}
          onDelete={() => onDelete(server)}
        />
      </div>
    ),
    [tCommon, isPending, router, onDelete]
  );

  if (optimisticServers.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={ServerIcon}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button asChild>
              <Link href="/servers/new">
                <Plus className="size-4" />
                {t("addServer")}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <DataTable
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

function ServerActions({
  disabled,
  menuLabel,
  triggerLabel,
  editLabel,
  deleteLabel,
  onEdit,
  onDelete,
}: {
  disabled: boolean;
  menuLabel: string;
  triggerLabel: string;
  editLabel: string;
  deleteLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={triggerLabel}
          disabled={disabled}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
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
