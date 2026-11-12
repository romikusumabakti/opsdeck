import {
  Eye,
  FolderOpen,
  KeyRound,
  Pencil,
  Plus,
  Server as ServerIcon,
  ShieldAlert,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { type RowAction, RowActions } from "@/components/ui/row-actions";
import { TooltipHint } from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import {
  bulkDeleteServers,
  deleteServer,
  type ServerRow as Server,
} from "@/web/api/servers";
import { accessState } from "./access-state";

// What the caller may do beyond listing (server:read), from the page. The
// terminal and files answers depend on the server: an infra-only one takes the
// org role alone (lib/permissions#canOrgAccessTarget).
export type ServerCapabilities = {
  manage: boolean;
  terminal: (infraOnly: boolean) => boolean;
  files: (infraOnly: boolean) => boolean;
};

export function ServersClient({
  servers,
  can,
}: {
  servers: Server[];
  can: ServerCapabilities;
}) {
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
        // The Panel cannot reach a deleted server, so its key line there is
        // the admin's to remove.
        description:
          server.auth === "key" ? (
            <>
              {t("deleteDescription", {
                name: server.name,
                host: server.host,
              })}{" "}
              {t("deleteKeyNote", {
                marker: server.keyMarker ?? "opsdeck:…",
              })}
            </>
          ) : (
            t("deleteDescription", { name: server.name, host: server.host })
          ),
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
        description: servers.some((s) => ids.includes(s.id) && s.auth === "key")
          ? `${t("bulkDeleteDescription")} ${t("bulkDeleteKeyNote")}`
          : t("bulkDeleteDescription"),
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

  const columns = React.useMemo<DataTableColumnDef<Server>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colName") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colName")} />
        ),
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{row.getValue("name")}</span>
            {row.original.infraOnly ? <InfraOnlyBadge /> : null}
          </span>
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
        id: "access",
        meta: { label: t("colAccess") },
        header: t("colAccess"),
        cell: ({ row }) => <AccessBadge server={row.original} />,
      },
      {
        id: "actions",
        enableHiding: false,
        meta: {
          headClassName: "w-24",
          cellClassName: "w-24",
        },
        cell: ({ row }) => (
          <ServerActions
            server={row.original}
            can={can}
            disabled={isPending}
            browseLabel={t("browseFiles")}
            terminalLabel={t("openTerminal")}
            menuLabel={tCommon("openMenu")}
            editLabel={can.manage ? tCommon("edit") : tCommon("view")}
            deleteLabel={tCommon("delete")}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [t, tCommon, isPending, onDelete, can]
  );

  const renderCard = React.useCallback(
    (server: Server) => (
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-medium truncate">{server.name}</span>
            {server.infraOnly ? <InfraOnlyBadge /> : null}
          </span>
          <span className="font-mono text-xs text-muted-foreground truncate">
            {server.host}
          </span>
          <span className="font-mono text-xs text-muted-foreground truncate">
            {server.username}
          </span>
          <AccessBadge server={server} />
        </div>
        <ServerActions
          server={server}
          can={can}
          disabled={isPending}
          browseLabel={t("browseFiles")}
          terminalLabel={t("openTerminal")}
          menuLabel={tCommon("openMenu")}
          editLabel={can.manage ? tCommon("edit") : tCommon("view")}
          deleteLabel={tCommon("delete")}
          onDelete={() => onDelete(server)}
        />
      </div>
    ),
    [t, tCommon, isPending, onDelete, can]
  );

  if (optimisticServers.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={ServerIcon}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            can.manage ? (
              <Button
                nativeButton={false}
                render={<Link href="/servers/new" />}
              >
                <Plus className="size-4" />
                {t("addServer")}
              </Button>
            ) : undefined
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
      bulkActions={
        can.manage
          ? (ids, clearSelection) => (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onBulkDelete(ids, clearSelection)}
                disabled={isPending}
              >
                <Trash2 className="size-4" />
                {t("bulkDelete")}
              </Button>
            )
          : undefined
      }
    />
  );
}

// The terminal and the file explorer of this server stay with org
// admin/infra.
function InfraOnlyBadge() {
  const t = useTranslations("servers");
  return <Badge variant="outline">{t("infraOnly")}</Badge>;
}

/**
 * How the Panel signs in (accessState): Key (the host key fingerprint on
 * hover), Key not verified yet, Password, Needs setup, or a warning when the
 * server offered another host key (nothing connects).
 */
function AccessBadge({ server }: { server: Server }) {
  const t = useTranslations("servers");
  switch (accessState(server)) {
    case "hostKeyChanged":
      return (
        <Badge variant="destructive">
          <ShieldAlert data-icon="inline-start" />
          {t("accessHostKeyChanged")}
        </Badge>
      );
    case "needsSetup":
      return <Badge variant="outline">{t("accessNeedsSetup")}</Badge>;
    case "password":
      return <Badge variant="outline">{t("accessPassword")}</Badge>;
    case "keyNotVerified":
      return (
        <Badge variant="outline">
          <KeyRound data-icon="inline-start" />
          {t("accessKeyNotVerified")}
        </Badge>
      );
    case "key":
      return (
        <TooltipHint
          label={
            server.hostKeyFingerprint
              ? t("hostKeyHint", { fingerprint: server.hostKeyFingerprint })
              : t("hostKeyNotPinnedHint")
          }
        >
          <Badge variant="secondary" tabIndex={0}>
            <KeyRound data-icon="inline-start" />
            {t("accessKey")}
          </Badge>
        </TooltipHint>
      );
  }
}

// Browsing is the row's primary action, so it stays a button; edit and delete
// live behind the ⋯ menu, which keeps a destructive control from sitting one
// stray click away from it. Rows are not clickable; navigation happens only
// through these action controls.
function ServerActions({
  server,
  can,
  disabled,
  browseLabel,
  terminalLabel,
  menuLabel,
  editLabel,
  deleteLabel,
  onDelete,
}: {
  server: Server;
  can: ServerCapabilities;
  disabled: boolean;
  browseLabel: string;
  terminalLabel: string;
  menuLabel: string;
  editLabel: string;
  deleteLabel: string;
  onDelete: () => void;
}) {
  const items: RowAction[] = [];
  if (can.terminal(server.infraOnly)) {
    items.push({
      label: terminalLabel,
      icon: SquareTerminal,
      href: `/servers/${server.id}/terminal`,
    });
  }
  // The detail page is read-only without server:manage.
  items.push({
    label: editLabel,
    icon: can.manage ? Pencil : Eye,
    href: `/servers/${server.id}`,
  });
  if (can.manage) {
    items.push({
      label: deleteLabel,
      icon: Trash2,
      destructive: true,
      onSelect: onDelete,
    });
  }
  return (
    <RowActions
      label={menuLabel}
      disabled={disabled}
      primary={
        can.files(server.infraOnly)
          ? {
              label: browseLabel,
              icon: FolderOpen,
              href: `/servers/${server.id}/files`,
            }
          : undefined
      }
      items={items}
    />
  );
}
