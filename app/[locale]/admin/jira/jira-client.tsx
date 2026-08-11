"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Cable, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { deleteJiraConnection } from "@/actions/jira";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { SafeJiraConnection } from "@/lib/db/schema";

export function JiraClient({
  connections,
}: {
  connections: SafeJiraConnection[];
}) {
  const t = useTranslations("jira");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const [optimistic, removeOptimistic] = useOptimistic<
    SafeJiraConnection[],
    string[]
  >(connections, (state, ids) => state.filter((c) => !ids.includes(c.id)));

  const onDelete = React.useCallback(
    async (conn: SafeJiraConnection) => {
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
        const result = await deleteJiraConnection(conn.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
      });
    },
    [dialog, t, tCommon, removeOptimistic]
  );

  const columns = React.useMemo<ColumnDef<SafeJiraConnection>[]>(
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
        accessorKey: "baseUrl",
        meta: { label: t("colBaseUrl") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colBaseUrl")} />
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.getValue("baseUrl")}</span>
        ),
      },
      {
        accessorKey: "flavor",
        meta: { label: t("colFlavor") },
        header: t("colFlavor"),
        cell: ({ row }) => (
          <Badge variant="secondary">
            {row.original.flavor === "cloud"
              ? t("flavorCloud")
              : t("flavorDatacenter")}
          </Badge>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-24", cellClassName: "w-24" },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tCommon("edit")}
              title={tCommon("edit")}
              disabled={isPending}
              render={<Link href={`/admin/jira/${row.original.id}`} />}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tCommon("delete")}
              title={tCommon("delete")}
              disabled={isPending}
              onClick={() => onDelete(row.original)}
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </div>
        ),
      },
    ],
    [t, tCommon, isPending, onDelete]
  );

  if (optimistic.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={Cable}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button render={<Link href="/admin/jira/new" />}>
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
      urlKey="jira"
    />
  );
}
