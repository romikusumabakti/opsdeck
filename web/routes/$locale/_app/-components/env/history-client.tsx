import {
  ArrowUpDown,
  CheckCircle2,
  CircleAlert,
  History as HistoryIcon,
  Loader2,
} from "lucide-react";
import * as React from "react";
import { useFormatter, useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  type DataTableColumnDef,
  type DataTableFacet,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { UserName } from "@/components/user/user-name";
import { facetFilterFn } from "@/lib/facet-filter";
import { DATE_TIME } from "@/lib/format-date";
import type { RunWithUser } from "@/web/api/runs";

// Facet keys for runs without a kind or an author; labels come from i18n.
const KIND_OTHER = "other";
const USER_UNKNOWN = "__unknown";
const KINDS = ["backup", "restore", "mock_time", "test", KIND_OTHER] as const;
const STATUSES = ["success", "failed", "started"] as const;
const STATUS_LABEL_KEY = {
  success: "statusSuccess",
  failed: "statusFailed",
  started: "statusRunning",
} as const;
const KIND_LABEL_KEY = {
  backup: "kindBackup",
  restore: "kindRestore",
  mock_time: "kindMockTime",
  test: "kindTest",
  other: "kindOther",
} as const;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function HistoryClient({ runs }: { runs: RunWithUser[] }) {
  const t = useTranslations("history");
  const format = useFormatter();

  // Tick every second so the duration column for in-progress runs updates
  // live. Cheap because filteredCount is small and only re-renders cells.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!runs.some((run) => run.status === "started")) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [runs]);

  const columns = React.useMemo<DataTableColumnDef<RunWithUser>[]>(
    () => [
      {
        id: "status",
        accessorKey: "status",
        header: t("colStatus"),
        filterFn: facetFilterFn,
        cell: ({ row }) => <StatusBadge status={row.original.status} t={t} />,
        meta: { headClassName: "w-32", label: t("colStatus") },
      },
      {
        accessorKey: "description",
        meta: { label: t("colDescription"), cellClassName: "max-w-[28rem]" },
        header: t("colDescription"),
        cell: ({ row }) => {
          const description = row.getValue("description") as string;
          return (
            <span className="font-medium block truncate" title={description}>
              {description}
            </span>
          );
        },
      },
      {
        // Filter-only: `kind` has no column of its own, but the facet needs a
        // value to match on, and a hidden column still takes part in filtering.
        id: "kind",
        accessorFn: (row) => row.kind ?? KIND_OTHER,
        filterFn: facetFilterFn,
        enableHiding: false,
        meta: { label: t("colKind") },
      },
      {
        id: "user",
        accessorFn: (row) => row.user?.id ?? USER_UNKNOWN,
        filterFn: facetFilterFn,
        meta: { label: t("colUser") },
        header: t("colUser"),
        cell: ({ row }) => {
          const user = row.original.user;
          return user ? (
            <UserName
              user={user}
              avatar
              className="text-sm text-muted-foreground"
            />
          ) : (
            <span className="text-sm italic text-muted-foreground">
              {t("userUnknown")}
            </span>
          );
        },
      },
      {
        accessorKey: "runAt",
        meta: { label: t("colRunAt") },
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
            {format.dateTime(
              new Date(row.getValue("runAt") as Date),
              DATE_TIME
            )}
          </span>
        ),
      },
      {
        id: "duration",
        meta: { label: t("colDuration") },
        header: t("colDuration"),
        cell: ({ row }) => {
          const run = row.original;
          // Tasks still running have no completedAt; show live elapsed time
          // so the user sees the operation hasn't stalled.
          const endMs = run.completedAt
            ? new Date(run.completedAt).getTime()
            : Date.now();
          const ms = endMs - new Date(run.runAt).getTime();
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

  const facets = React.useMemo<DataTableFacet[]>(() => {
    const users = new Map<string, string>();
    for (const run of runs) {
      if (run.user) users.set(run.user.id, run.user.name);
    }
    const userOptions = [...users]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (runs.some((run) => !run.user)) {
      userOptions.push({ value: USER_UNKNOWN, label: t("userUnknown") });
    }
    return [
      {
        columnId: "kind",
        title: t("colKind"),
        options: KINDS.map((k) => ({ value: k, label: t(KIND_LABEL_KEY[k]) })),
      },
      {
        columnId: "status",
        title: t("colStatus"),
        options: STATUSES.map((s) => ({
          value: s,
          label: t(STATUS_LABEL_KEY[s]),
        })),
      },
      { columnId: "user", title: t("colUser"), options: userOptions },
    ];
  }, [runs, t]);

  if (runs.length === 0) {
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
      fillHeight
      columns={columns}
      data={runs}
      filterColumn="description"
      filterPlaceholder={t("searchPlaceholder")}
      urlKey="hist"
      facets={facets}
      initialColumnVisibility={{ kind: false }}
    />
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: RunWithUser["status"];
  t: (key: string) => string;
}) {
  if (status === "success") {
    return (
      <Badge className="bg-success/15 text-success hover:bg-success/15 border-transparent gap-1">
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
