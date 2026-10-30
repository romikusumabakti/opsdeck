import { Mail, Send, Trash2 } from "lucide-react";
import * as React from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import {
  bulkRevokeInvitations,
  resendInvitation,
  revokeInvitation,
} from "@/web/api/users";
import type { InvitationAction, InvitationRow } from "./types";
import { RoleBadge } from "./user-badges";

// One invitation list (Pending or Expired). Both share columns and actions;
// `urlKey` keeps their table state apart in the URL.
export function InvitationsTable({
  invitations,
  urlKey,
  applyOptimistic,
}: {
  invitations: InvitationRow[];
  urlKey: string;
  applyOptimistic: (action: InvitationAction) => void;
}) {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const onRevoke = React.useCallback(
    async (inv: InvitationRow) => {
      const ok = await dialog.confirm({
        title: t("revokeTitle"),
        description: t("revokeDescription", { email: inv.email }),
        confirmText: t("revoke"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "remove", ids: [inv.id] });
        const result = await revokeInvitation(inv.id);
        if (!result.success) {
          toast.error(result.message ?? "");
          return;
        }
        toast.success(result.message ?? t("revokedSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onResend = React.useCallback(
    async (inv: InvitationRow) => {
      const ok = await dialog.confirm({
        title: t("resendTitle"),
        description: t("resendDescription", { email: inv.email }),
        confirmText: t("resend"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({
          type: "renew",
          id: inv.id,
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        });
        const result = await resendInvitation(inv.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("resendSuccess"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const onBulkRevoke = React.useCallback(
    async (ids: string[], clearSelection: () => void) => {
      const ok = await dialog.confirm({
        title: t("bulkRevokeTitle", { count: ids.length }),
        description: t("bulkRevokeDescription"),
        confirmText: t("revoke"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "remove", ids });
        clearSelection();
        const result = await bulkRevokeInvitations(ids);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(t("bulkRevokedSuccess", { count: result.revoked }));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const columns = React.useMemo<DataTableColumnDef<InvitationRow>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colInvitee") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colInvitee")} />
        ),
        cell: ({ row }) => {
          const inv = row.original;
          return (
            <div className="flex items-center gap-3">
              <span className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Mail className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{inv.name}</span>
                  <RoleBadge role={inv.role} />
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {inv.email}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "expiresAt",
        meta: { label: t("colExpires") },
        header: t("colExpires"),
        cell: ({ row }) => {
          const expiresAt = new Date(row.getValue("expiresAt") as Date);
          const isExpired = expiresAt.getTime() < Date.now();
          return (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {format.dateTime(expiresAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
              {isExpired && (
                <Badge variant="destructive" className="text-xs">
                  {t("expiredBadge")}
                </Badge>
              )}
            </div>
          );
        },
      },
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-24", cellClassName: "w-24" },
        cell: ({ row }) => {
          const inv = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("resend")}
                title={t("resend")}
                disabled={isPending}
                onClick={() => onResend(inv)}
              >
                <Send className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("revoke")}
                title={t("revoke")}
                disabled={isPending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onRevoke(inv)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          );
        },
      },
    ],
    [t, isPending, onRevoke, onResend, format]
  );

  return (
    <DataTable
      fillHeight
      columns={columns}
      data={invitations}
      initialPageSize={25}
      getRowId={(row) => row.id}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      urlKey={urlKey}
      bulkActions={(ids, clearSelection) => (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onBulkRevoke(ids, clearSelection)}
          disabled={isPending}
        >
          <Trash2 className="size-4" />
          {t("bulkRevoke")}
        </Button>
      )}
    />
  );
}
