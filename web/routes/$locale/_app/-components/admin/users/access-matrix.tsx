import { Check } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import type { AccessMatrix as Matrix } from "@/web/api/access";
import type { UserRow } from "./types";
import { RoleBadge } from "./user-badges";
import { UserIdentityCell } from "./user-identity-cell";

// Read-only overview of who can reach which project. Roles are changed on the
// Users tab and memberships in each project's settings, so this view has no
// write path of its own.
export function AccessMatrix({
  users,
  matrix,
  now,
  currentUserId,
  toolbar,
}: {
  // Already filtered by the shell (banned/inactive toggles).
  users: UserRow[];
  matrix: Matrix;
  now: Date;
  currentUserId: string;
  toolbar: React.ReactNode;
}) {
  const t = useTranslations("users");
  const tAccess = useTranslations("access");

  const columns = React.useMemo<DataTableColumnDef<UserRow>[]>(() => {
    const projectColumns: DataTableColumnDef<UserRow>[] = matrix.projects.map(
      (p) => ({
        id: `project-${p.id}`,
        meta: { label: p.key },
        header: () => (
          <span title={p.name} className="font-mono text-sm">
            {p.key}
          </span>
        ),
        cell: ({ row }) => {
          const isMember =
            matrix.memberships[row.original.id]?.includes(p.id) ?? false;
          return isMember ? (
            <Check
              className="size-4"
              role="img"
              aria-label={tAccess("isMember")}
            />
          ) : (
            <span
              role="img"
              className="text-muted-foreground"
              aria-label={tAccess("notMember")}
            >
              –
            </span>
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
        cell: ({ row }) => (
          <div className={cn("min-w-0", row.original.banned && "opacity-50")}>
            <UserIdentityCell
              user={row.original}
              isSelf={row.original.id === currentUserId}
              now={now}
            />
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
        cell: ({ row }) => {
          const at = row.original.lastActiveAt;
          return (
            <span className="text-sm text-muted-foreground">
              {at ? <RelativeTime date={at} /> : t("neverActive")}
            </span>
          );
        },
      },
      ...projectColumns,
    ];
  }, [matrix, t, tAccess, currentUserId, now]);

  return (
    <DataTable
      fillHeight
      columns={columns}
      data={users}
      initialPageSize={25}
      filterColumn="name"
      filterPlaceholder={t("searchPlaceholder")}
      getRowId={(row) => row.id}
      urlKey="acc"
      toolbar={toolbar}
    />
  );
}
