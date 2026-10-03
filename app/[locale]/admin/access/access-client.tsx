"use client";

import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { type AccessMatrix, offboardUser } from "@/actions/access";
import { updateUserRole } from "@/actions/users";
import { useDialog } from "@/components/dialog-provider";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isInactive } from "@/lib/access";
import { isOrgRole, ORG_ROLES, type OrgRole } from "@/lib/permissions";

type Row = AccessMatrix["users"][number];

type OptimisticAction =
  | { type: "role"; id: string; role: OrgRole }
  | { type: "ban"; id: string };

export function AccessClient({
  matrix,
  now,
  selfId,
  canEdit,
  canOffboard,
}: {
  matrix: AccessMatrix;
  now: string;
  selfId: string;
  // Computed on the server with canOrg; the actions enforce the same checks.
  canEdit: boolean;
  canOffboard: boolean;
}) {
  const t = useTranslations("access");
  const tUsers = useTranslations("users");
  const tRole = useTranslations("projectMembers.role");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();
  const [onlyInactive, setOnlyInactive] = React.useState(false);
  const [showBanned, setShowBanned] = React.useState(false);
  const nowDate = React.useMemo(() => new Date(now), [now]);

  const [users, applyOptimistic] = useOptimistic<Row[], OptimisticAction>(
    matrix.users,
    (state, action) =>
      state.map((u) => {
        if (u.id !== action.id) return u;
        return action.type === "role"
          ? { ...u, role: action.role }
          : { ...u, banned: true, memberships: {} };
      })
  );

  const rows = React.useMemo(
    () =>
      users.filter(
        (u) =>
          (showBanned || !u.banned) &&
          (!onlyInactive ||
            isInactive(u.lastSeen ? new Date(u.lastSeen) : null, nowDate))
      ),
    [users, showBanned, onlyInactive, nowDate]
  );

  const onChangeRole = React.useCallback(
    async (user: Row, role: OrgRole) => {
      if (role === user.role) return;
      const ok = await dialog.confirm({
        title: tUsers("roleChangeTitle"),
        description: tUsers("roleChangeDescription", {
          name: user.name,
          role: tUsers(`role.${role}`),
        }),
        confirmText: tUsers("roleChangeConfirm"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "role", id: user.id, role });
        const result = await updateUserRole({ userId: user.id, role });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? tUsers("roleChangedSuccess"));
      });
    },
    [dialog, tUsers, tCommon, applyOptimistic]
  );

  const onOffboard = React.useCallback(
    async (user: Row) => {
      const ok = await dialog.confirm({
        title: t("offboardTitle"),
        description: t("offboardConfirm", { name: user.name }),
        confirmText: t("offboard"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        applyOptimistic({ type: "ban", id: user.id });
        const result = await offboardUser(user.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? t("offboarded"));
      });
    },
    [dialog, t, tCommon, applyOptimistic]
  );

  const columns = React.useMemo<DataTableColumnDef<Row>[]>(() => {
    const projectColumns: DataTableColumnDef<Row>[] = matrix.projects.map(
      (p) => ({
        id: `project-${p.id}`,
        meta: { label: p.key },
        header: () => (
          <span title={p.name} className="font-mono text-xs">
            {p.key}
          </span>
        ),
        cell: ({ row }) => {
          const role = row.original.memberships[p.id];
          return role ? (
            <Badge variant="secondary" className="text-xs">
              {tRole(role)}
            </Badge>
          ) : (
            <span className="text-muted-foreground">–</span>
          );
        },
      })
    );
    return [
      {
        accessorKey: "name",
        enableHiding: false,
        meta: { label: t("colUser") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colUser")} />
        ),
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className={u.banned ? "min-w-0 opacity-50" : "min-w-0"}>
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{u.name}</span>
                {u.id === selfId && (
                  <Badge variant="secondary" className="text-xs">
                    {tCommon("you")}
                  </Badge>
                )}
                {u.banned && (
                  <Badge variant="destructive" className="text-xs">
                    {t("banned")}
                  </Badge>
                )}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {u.email}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "role",
        meta: { label: t("colOrgRole") },
        header: t("colOrgRole"),
        cell: ({ row }) => {
          const u = row.original;
          if (!canEdit || u.id === selfId || u.banned) {
            return (
              <Badge
                variant={u.role === "admin" ? "default" : "secondary"}
                className="text-xs"
              >
                {tUsers(`role.${u.role}`)}
              </Badge>
            );
          }
          return (
            <Select
              value={u.role}
              disabled={isPending}
              onValueChange={(v) => {
                if (v && isOrgRole(v)) onChangeRole(u, v);
              }}
            >
              <SelectTrigger size="sm" className="w-32">
                <SelectValue>{tUsers(`role.${u.role}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ORG_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tUsers(`role.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        },
      },
      {
        accessorKey: "lastSeen",
        meta: { label: t("colLastSeen") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colLastSeen")} />
        ),
        cell: ({ row }) => {
          const at = row.original.lastSeen
            ? new Date(row.original.lastSeen)
            : null;
          return (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                {at ? format.relativeTime(at, nowDate) : t("never")}
              </span>
              {isInactive(at, nowDate) && (
                <Badge variant="outline" className="text-xs">
                  {t("inactive")}
                </Badge>
              )}
            </div>
          );
        },
      },
      ...projectColumns,
      {
        id: "actions",
        enableHiding: false,
        meta: { headClassName: "w-28", cellClassName: "w-28" },
        cell: ({ row }) => {
          const u = row.original;
          if (!canOffboard || u.banned || u.id === selfId) return null;
          return (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                disabled={isPending}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onOffboard(u)}
              >
                {t("offboard")}
              </Button>
            </div>
          );
        },
      },
    ];
  }, [
    matrix.projects,
    t,
    tUsers,
    tRole,
    tCommon,
    format,
    nowDate,
    selfId,
    canEdit,
    canOffboard,
    isPending,
    onChangeRole,
    onOffboard,
  ]);

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <DataTable
        fillHeight
        columns={columns}
        data={rows}
        initialPageSize={25}
        filterColumn="name"
        filterPlaceholder={tUsers("searchPlaceholder")}
        getRowId={(row) => row.id}
        urlKey="acc"
        toolbar={
          <div className="flex items-center gap-4 text-sm">
            <label
              htmlFor="access-filter-inactive"
              className="flex items-center gap-2"
            >
              <Checkbox
                id="access-filter-inactive"
                checked={onlyInactive}
                onCheckedChange={(v) => setOnlyInactive(v === true)}
              />
              {t("filterInactive")}
            </label>
            <label
              htmlFor="access-filter-banned"
              className="flex items-center gap-2"
            >
              <Checkbox
                id="access-filter-banned"
                checked={showBanned}
                onCheckedChange={(v) => setShowBanned(v === true)}
              />
              {t("filterBanned")}
            </label>
          </div>
        }
      />
    </>
  );
}
