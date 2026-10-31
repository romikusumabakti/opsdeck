import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
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
import { RowActions } from "@/components/ui/row-actions";
import { Link } from "@/i18n/navigation";
import {
  deleteCloudflareZone,
  type ZoneRow as SafeCloudflareZone,
} from "@/web/api/tunnels";

export function ZonesClient({
  zones,
  canManage,
}: {
  zones: SafeCloudflareZone[];
  canManage: boolean;
}) {
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
          <RowActions
            label={tCommon("openMenu")}
            disabled={isPending}
            primary={{
              label: tCommon("edit"),
              icon: Pencil,
              href: `/admin/tunnels/zones/${row.original.id}`,
            }}
            items={[
              {
                label: tCommon("delete"),
                icon: Trash2,
                destructive: true,
                onSelect: () => onDelete(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [t, tCommon, isPending, onDelete]
  );
  const visibleColumns = canManage
    ? columns
    : columns.filter((c) => c.id !== "actions");

  if (optimistic.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={KeyRound}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            canManage ? (
              <Button
                nativeButton={false}
                render={<Link href="/admin/tunnels/zones/new" />}
              >
                <Plus className="size-4" />
                {t("addZone")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <DataTable
      columns={visibleColumns}
      data={optimistic}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      getRowId={(row) => row.id}
      urlKey="zones"
    />
  );
}
