"use client";

import { Cloud, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { deleteTunnel } from "@/actions/tunnels";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { TunnelWithContext } from "@/lib/db/schema";

export function TunnelsClient({
  tunnels,
  hasZones,
}: {
  tunnels: TunnelWithContext[];
  hasZones: boolean;
}) {
  const t = useTranslations("tunnels");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const [optimistic, removeOptimistic] = useOptimistic<
    TunnelWithContext[],
    string[]
  >(tunnels, (state, ids) => state.filter((row) => !ids.includes(row.id)));

  const onDelete = React.useCallback(
    async (tunnel: TunnelWithContext) => {
      const ok = await dialog.confirmTyping({
        title: t("deleteTitle"),
        // Spelled out because the wording matters: this removes the panel's
        // record, not the tunnel. Every hostname keeps working afterwards.
        description: t("deleteDescription", { name: tunnel.name }),
        phrase: tunnel.name,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        removeOptimistic([tunnel.id]);
        const result = await deleteTunnel(tunnel.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
      });
    },
    [dialog, t, tCommon, removeOptimistic]
  );

  const columns = React.useMemo<DataTableColumnDef<TunnelWithContext>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colName") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colName")} />
        ),
        cell: ({ row }) => (
          <Link
            href={`/admin/tunnels/${row.original.id}`}
            className="font-medium hover:underline"
          >
            {row.getValue("name")}
          </Link>
        ),
      },
      {
        id: "server",
        meta: { label: t("colServer") },
        header: t("colServer"),
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.server.name}
            <span className="text-muted-foreground font-mono text-xs ml-2">
              {row.original.server.host}
            </span>
          </span>
        ),
      },
      {
        id: "zone",
        meta: { label: t("colZone") },
        header: t("colZone"),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.zone.name}</span>
        ),
      },
      {
        accessorKey: "stackDir",
        meta: { label: t("colStackDir") },
        header: t("colStackDir"),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.getValue("stackDir")}
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
              render={<Link href={`/admin/tunnels/${row.original.id}/edit`} />}
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
          icon={Cloud}
          title={t("emptyTitle")}
          description={hasZones ? t("empty") : t("emptyNoZone")}
          action={
            hasZones ? (
              <Button render={<Link href="/admin/tunnels/new" />}>
                <Plus className="size-4" />
                {t("addTunnel")}
              </Button>
            ) : (
              <Button render={<Link href="/admin/tunnels/zones/new" />}>
                <Plus className="size-4" />
                {t("addZone")}
              </Button>
            )
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
      urlKey="tunnels"
    />
  );
}
