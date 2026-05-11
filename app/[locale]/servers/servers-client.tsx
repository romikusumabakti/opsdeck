"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowUpDown,
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
import { deleteServer } from "@/actions/servers";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
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

  // Optimistic removal: drop the row from the table immediately so the user
  // sees the result of their click. React rolls back automatically if the
  // server action throws or the parent revalidation produces a different list.
  const [optimisticServers, removeOptimistic] = useOptimistic<Server[], string>(
    servers,
    (state, idToRemove) => state.filter((s) => s.id !== idToRemove)
  );

  const onDelete = React.useCallback(
    async (server: Server) => {
      const ok = await dialog.confirm({
        title: t("deleteTitle"),
        description: t("deleteDescription", {
          name: server.name,
          host: server.host,
        }),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        removeOptimistic(server.id);
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

  const columns = React.useMemo<ColumnDef<Server>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            {t("colName")}
            <ArrowUpDown className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="font-medium">{row.getValue("name")}</span>
        ),
      },
      {
        accessorKey: "host",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            {t("colHost")}
            <ArrowUpDown className="size-3.5" />
          </Button>
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
        cell: ({ row }) => {
          const server = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tCommon("openMenu")}
                  disabled={isPending}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{tCommon("actions")}</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => router.push(`/servers/${server.id}`)}
                >
                  <Pencil className="size-4" />
                  {tCommon("edit")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDelete(server)}
                >
                  <Trash2 className="size-4" />
                  {tCommon("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [t, tCommon, isPending, router, onDelete]
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
    />
  );
}
