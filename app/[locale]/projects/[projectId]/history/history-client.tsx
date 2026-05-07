"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown, History as HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { Task } from "@/lib/db/schema";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function HistoryClient({ tasks }: { tasks: Task[] }) {
  const t = useTranslations("history");

  const columns = React.useMemo<ColumnDef<Task>[]>(
    () => [
      {
        accessorKey: "description",
        header: t("colDescription"),
        cell: ({ row }) => (
          <span className="font-medium">{row.getValue("description")}</span>
        ),
      },
      {
        accessorKey: "runAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 h-8"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            {t("colRunAt")}
            <ArrowUpDown className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {new Date(row.getValue("runAt") as Date).toLocaleString()}
          </span>
        ),
      },
      {
        id: "duration",
        header: t("colDuration"),
        cell: ({ row }) => {
          const task = row.original;
          const ms =
            new Date(task.completedAt).getTime() -
            new Date(task.runAt).getTime();
          return (
            <span className="font-mono text-xs text-muted-foreground">
              {formatDuration(ms)}
            </span>
          );
        },
      },
    ],
    [t]
  );

  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={HistoryIcon}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
        />
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={tasks}
      filterColumn="description"
      filterPlaceholder={t("searchPlaceholder")}
    />
  );
}
