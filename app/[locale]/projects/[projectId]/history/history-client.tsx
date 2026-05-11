"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowUpDown,
  CheckCircle2,
  CircleAlert,
  History as HistoryIcon,
  Loader2,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import type { TaskWithUser } from "@/actions/tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function HistoryClient({ tasks }: { tasks: TaskWithUser[] }) {
  const t = useTranslations("history");
  const format = useFormatter();

  // Tick every second so the duration column for in-progress tasks updates
  // live. Cheap because filteredCount is small and only re-renders cells.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!tasks.some((task) => task.status === "started")) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [tasks]);

  const columns = React.useMemo<ColumnDef<TaskWithUser>[]>(
    () => [
      {
        id: "status",
        accessorKey: "status",
        header: t("colStatus"),
        cell: ({ row }) => <StatusBadge status={row.original.status} t={t} />,
        meta: { headClassName: "w-32" },
      },
      {
        accessorKey: "description",
        header: t("colDescription"),
        cell: ({ row }) => (
          <span className="font-medium">{row.getValue("description")}</span>
        ),
      },
      {
        id: "user",
        accessorFn: (row) => row.user?.name ?? "",
        header: t("colUser"),
        cell: ({ row }) => {
          const user = row.original.user;
          return user ? (
            <span className="text-sm text-muted-foreground" title={user.email}>
              {user.name}
            </span>
          ) : (
            <span className="text-sm italic text-muted-foreground">
              {t("userUnknown")}
            </span>
          );
        },
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
            {format.dateTime(new Date(row.getValue("runAt") as Date), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        ),
      },
      {
        id: "duration",
        header: t("colDuration"),
        cell: ({ row }) => {
          const task = row.original;
          // Tasks still running have no completedAt; show live elapsed time
          // so the user sees the operation hasn't stalled.
          const endMs = task.completedAt
            ? new Date(task.completedAt).getTime()
            : Date.now();
          const ms = endMs - new Date(task.runAt).getTime();
          return (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {formatDuration(ms)}
            </span>
          );
        },
      },
    ],
    [t, format]
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

function StatusBadge({
  status,
  t,
}: {
  status: TaskWithUser["status"];
  t: (key: string) => string;
}) {
  if (status === "success") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 border-transparent gap-1">
        <CheckCircle2 className="size-3" />
        {t("statusSuccess")}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlert className="size-3" />
        {t("statusFailed")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="size-3 animate-spin" />
      {t("statusRunning")}
    </Badge>
  );
}
