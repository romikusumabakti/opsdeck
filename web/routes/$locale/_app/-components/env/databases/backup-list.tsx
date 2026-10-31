import { DatabaseBackup, RotateCcw } from "lucide-react";
import * as React from "react";
import { useFormatter, useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import {
  DataTable,
  type DataTableColumnDef,
  DataTableColumnHeader,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { RowActions } from "@/components/ui/row-actions";
import type { Backup } from "@/lib/types";
import type { DatabaseEntry } from "@/web/api/databases";
import type { EnvironmentWithServers } from "@/web/api/environments";
import { BackupDatabase } from "../backup-database";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

// Locale-aware size: the largest unit that keeps the value at or above 1.
function sizeParts(bytes: number) {
  const i = Math.min(
    bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0,
    UNITS.length - 1
  );
  return { value: bytes / 1024 ** i, unit: UNITS[i] ?? "byte" };
}

// This environment's backup files, newest first. "Run backup" sits in the
// header (backup permission only); each row offers "Restore" (restore
// permission only), which hands the file name to the Restore tab.
export function BackupList({
  environment,
  databases,
  backups,
  canBackup,
  canRestore,
  onRestore,
}: {
  environment: EnvironmentWithServers;
  databases: DatabaseEntry[];
  backups: Backup[];
  canBackup: boolean;
  canRestore: boolean;
  onRestore: (name: string) => void;
}) {
  const t = useTranslations("databases");
  const tRestore = useTranslations("restoreDb");
  const format = useFormatter();

  const columns = React.useMemo<DataTableColumnDef<Backup>[]>(
    () => [
      {
        accessorKey: "name",
        meta: { label: t("colBackupName") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colBackupName")} />
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.name}</span>
        ),
      },
      {
        accessorKey: "modifiedAt",
        meta: { label: t("colModified") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colModified")} />
        ),
        cell: ({ row }) => (
          <RelativeTime
            date={row.original.modifiedAt}
            className="text-muted-foreground"
          />
        ),
      },
      {
        accessorKey: "size",
        meta: { label: t("colSize") },
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("colSize")} />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {(({ value, unit }) =>
              format.number(value, {
                style: "unit",
                unit,
                unitDisplay: "short",
                maximumFractionDigits: 1,
              }))(sizeParts(row.original.size))}
          </span>
        ),
      },
      ...(canRestore
        ? [
            {
              id: "actions",
              enableHiding: false,
              meta: { headClassName: "w-16", cellClassName: "w-16" },
              cell: ({ row }) => (
                <RowActions
                  label={tRestore("restore")}
                  items={[]}
                  primary={{
                    label: tRestore("restore"),
                    icon: RotateCcw,
                    onSelect: () => onRestore(row.original.name),
                  }}
                />
              ),
            } satisfies DataTableColumnDef<Backup>,
          ]
        : []),
    ],
    [t, tRestore, format, canRestore, onRestore]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("backupListTitle")}</h2>
        {canBackup ? (
          <BackupDatabase environment={environment} databases={databases} />
        ) : null}
      </div>
      <DataTable
        label={t("backupListTitle")}
        columns={columns}
        data={backups}
        getRowId={(row) => row.name}
        initialSorting={[{ id: "modifiedAt", desc: true }]}
        emptyState={
          <EmptyState
            icon={DatabaseBackup}
            title={t("noBackupsTitle")}
            description={t("noBackupsDescription")}
            className="py-10"
          />
        }
      />
    </div>
  );
}
