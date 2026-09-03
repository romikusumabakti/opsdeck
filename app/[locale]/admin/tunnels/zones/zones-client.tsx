"use client";

import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { deleteCloudflareZone } from "@/actions/tunnels";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { SafeCloudflareZone } from "@/lib/db/schema";

export function ZonesClient({ zones }: { zones: SafeCloudflareZone[] }) {
  const t = useTranslations("zones");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const [optimistic, removeOptimistic] = useOptimistic<
    SafeCloudflareZone[],
    string[]
  >(zones, (state, ids) => state.filter((z) => !ids.includes(z.id)));

  const onDelete = React.useCallback(
    async (zone: SafeCloudflareZone) => {
      const ok = await dialog.confirmTyping({
        title: t("deleteTitle"),
        description: t("deleteDescription", { name: zone.name }),
        phrase: zone.name,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        removeOptimistic([zone.id]);
        const result = await deleteCloudflareZone(zone.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
      });
    },
    [dialog, t, tCommon, removeOptimistic]
  );

  const columns = React.useMemo<DataTableColumnDef<SafeCloudflareZone>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colName") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colName")} />
        ),
        cell: ({ row }) => (
          <span className="font-mono font-medium">{row.getValue("name")}</span>
        ),
      },
      {
        accessorKey: "zoneId",
        meta: { label: t("colZoneId") },
        header: t("colZoneId"),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.getValue("zoneId")}
          </span>
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
              render={<Link href={`/admin/tunnels/zones/${row.original.id}`} />}
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
          icon={KeyRound}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button render={<Link href="/admin/tunnels/zones/new" />}>
              <Plus className="size-4" />
              {t("addZone")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={optimistic}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      getRowId={(row) => row.id}
      urlKey="zones"
    />
  );
}
