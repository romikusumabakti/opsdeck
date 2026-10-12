"use client";

import { Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import type { UserAction, UserRow } from "./types";
import { useUserActions } from "./use-user-actions";
import { RoleBadge } from "./user-badges";
import { UserIdentityCell } from "./user-identity-cell";
import { type UserPermissions, UserRowActions } from "./user-row-actions";

export function UsersTable({
  users,
  now,
  currentUserId,
  perms,
  applyOptimistic,
  toolbar,
}: {
  // Already filtered by the shell (banned/inactive toggles).
  users: UserRow[];
  now: Date;
  currentUserId: string;
  // Computed on the server with canOrg; the actions enforce the same checks.
  perms: UserPermissions;
  applyOptimistic: (action: UserAction) => void;
  toolbar: React.ReactNode;
}) {
  const t = useTranslations("users");
  const tAccess = useTranslations("access");
  const format = useFormatter();
  const actions = useUserActions({ users, currentUserId, applyOptimistic });
  const { isPending, onBulkDelete } = actions;

  const renderIdentity = React.useCallback(
    (user: UserRow, showRole: boolean) => (
      <UserIdentityCell
        user={user}
        isSelf={user.id === currentUserId}
        now={now}
        showRole={showRole}
      />
    ),
    [currentUserId, now]
  );

  const renderActions = React.useCallback(
    (user: UserRow) => (
      <UserRowActions
        user={user}
        isSelf={user.id === currentUserId}
        perms={perms}
        actions={actions}
      />
    ),
    [currentUserId, perms, actions]
  );

  const renderLastActive = React.useCallback(
    (at: Date | null) => {
      if (!at) {
        return (
          <span className="text-sm text-muted-foreground">
            {t("neverActive")}
          </span>
        );
      }
      const date = new Date(at);
      return (
        <span
          className="text-sm text-muted-foreground"
          title={format.dateTime(date, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        >
          {format.relativeTime(date, now)}
        </span>
      );
    },
    [t, format, now]
  );

  // The role badge rides in the identity on cards; the table has its own
  // sortable Org role column instead.
  const renderCard = React.useCallback(
    (user: UserRow) => (
      <div className={cn("flex flex-col gap-2", user.banned && "opacity-50")}>
        <div className="flex items-start justify-between gap-3">
          {renderIdentity(user, true)}
          {renderActions(user)}
        </div>
        <div className="ps-12 text-sm text-muted-foreground">
          {renderLastActive(user.lastActiveAt)}
          {" · "}
          {t("colProjects")}: {user.projectCount}
        </div>
      </div>
    ),
    [renderIdentity, renderActions, renderLastActive, t]
  );

  const columns = React.useMemo<DataTableColumnDef<UserRow>[]>(
    () => [
      {
        accessorKey: "name",
        enableHiding: false,
        meta: { label: t("colUser") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colUser")} />
        ),
        cell: ({ row }) => (
          <div className={cn("min-w-0", row.original.banned && "opacity-50")}>
            {renderIdentity(row.original, false)}
          </div>
        ),
      },
      {
        accessorKey: "role",
        meta: { label: tAccess("colOrgRole") },
        header: ({ column }) => (
          <DataTableColumnHeader
            column={column}
            title={tAccess("colOrgRole")}
          />
        ),
        cell: ({ row }) => <RoleBadge role={row.original.role} />,
      },
      {
        accessorKey: "lastActiveAt",
        meta: { label: t("colLastActive") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colLastActive")} />
        ),
        cell: ({ row }) => renderLastActive(row.original.lastActiveAt),
      },
      {
        accessorKey: "projectCount",
        meta: { label: t("colProjects") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colProjects")} />
        ),
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {row.original.projectCount}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-44", cellClassName: "w-44" },
        cell: ({ row }) => renderActions(row.original),
      },
    ],
    [t, tAccess, renderIdentity, renderActions, renderLastActive]
  );

  return (
    <DataTable
      fillHeight
      columns={columns}
      data={users}
      initialPageSize={25}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      getRowId={(row) => row.id}
      canSelectRow={(row) => perms.canDelete && row.id !== currentUserId}
      urlKey="usr"
      renderCard={renderCard}
      toolbar={toolbar}
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
