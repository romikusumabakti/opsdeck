"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import { deleteServer } from "@/actions/servers";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link, useRouter } from "@/i18n/navigation";
import type { Server } from "@/lib/db/schema";

export function ServersClient({ servers }: { servers: Server[] }) {
  const t = useTranslations("servers");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

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
        const result = await deleteServer(server.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("deletedSuccess"));
      });
    },
    [dialog, t, tCommon]
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

  if (servers.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 flex flex-col items-center text-center gap-3">
          <p className="text-muted-foreground">{t("empty")}</p>
          <Button asChild size="sm">
            <Link href="/servers/new">{t("addServer")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={servers}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
    />
  );
}
