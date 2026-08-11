"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { CircleDot, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { GlobalIssue } from "@/actions/issues";
import {
  bulkDeleteIssues,
  bulkSetStatus,
  setIssueStatus,
  updateIssue,
} from "@/actions/issues";
import { useDialog } from "@/components/dialog-provider";
import {
  type AssignableUser,
  AssigneeSelect,
  IssueBoard,
  type Priority,
  PrioritySelect,
  STATUSES,
  type Status,
  StatusSelect,
  type Swimlane,
  TypeIcon,
} from "@/components/issues-board";
import {
  type FilterOption,
  type FilterPatch,
  IssuesFilterBar,
} from "@/components/issues-filter-bar";
import {
  IssuesSavedViews,
  type SavedViewItem,
} from "@/components/issues-saved-views";
import { LabelChips } from "@/components/label-ui";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { BOARD_LIMIT, TABLE_URL_KEY } from "@/lib/issue-query";

/**
 * One page of issues, patched in place. `remove` covers a bulk delete: the rows
 * disappear the moment the action starts instead of after the round-trip.
 */
type OptimisticAction =
  | { type: "patch"; ids: string[]; changes: Partial<GlobalIssue> }
  | { type: "remove"; ids: string[] };

/**
 * What the server sorts by when the URL says nothing — kept module-level so the
 * table sees a stable reference.
 */
const DEFAULT_SORTING = [{ id: "updatedAt", desc: true }];

/** Issue detail lives under the project key, not under the global list. */
const issueHref = (issue: GlobalIssue) =>
  `/${issue.project.key}/issues/${issue.number}`;

export function GlobalIssuesClient({
  issues,
  total,
  users,
  allLabels,
  projects,
  savedViews,
  filters,
  pageSize,
}: {
  /** The current page, already filtered/sorted/sliced by the server. */
  issues: GlobalIssue[];
  /** Rows matching the filter across all pages — drives the pager. */
  total: number;
  users: AssignableUser[];
  allLabels: FilterOption[];
  projects: FilterOption[];
  savedViews: SavedViewItem[];
  filters: Record<string, string>;
  pageSize: number;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const dialog = useDialog();
  // next/navigation (not the localized wrapper): these calls rewrite the query
  // of the path we are already on, which is locale-prefixed already. The
  // localized `Link` is still used for hrefs that need the prefix added.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();

  const usersById = React.useMemo(
    () => Object.fromEntries(users.map((u) => [u.id, u.name])),
    [users]
  );

  // Inline edits show instantly and roll back on their own: when the action
  // fails, the transition ends without new server data and React drops the
  // optimistic layer. On success `router.refresh()` (inside the same
  // transition) supplies the real row before the layer is dropped, so there is
  // no flash of stale values in either direction.
  const [rows, applyOptimistic] = React.useOptimistic(
    issues,
    (state: GlobalIssue[], action: OptimisticAction) =>
      action.type === "remove"
        ? state.filter((i) => !action.ids.includes(i.id))
        : state.map((i) =>
            action.ids.includes(i.id) ? { ...i, ...action.changes } : i
          )
  );

  /**
   * Apply a patch to the URL query — the single entry point for every filter,
   * because the query string is what the server reads to build the page.
   */
  const setParams = React.useCallback(
    (patch: FilterPatch) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      // A changed filter makes the current page number meaningless — page 4 of
      // the old result set is rarely page 4 of the new one.
      next.delete(`${TABLE_URL_KEY}_p`);
      const qs = next.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [pathname, router, searchParams]
  );

  const applyView = React.useCallback(
    (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [pathname, router]
  );

  const currentParams = React.useMemo(
    () => Object.fromEntries(searchParams.entries()),
    [searchParams]
  );

  /**
   * Run a mutation with its optimistic patch. Everything happens inside one
   * transition so the optimistic state survives until the refreshed server data
   * (or the failure) lands.
   */
  const mutate = React.useCallback(
    (
      action: OptimisticAction,
      run: () => Promise<{ success: boolean }>,
      successMessage?: string
    ) => {
      startTransition(async () => {
        applyOptimistic(action);
        const result = await run();
        if (!result.success) {
          toast.error(t("updateFailed"));
          return;
        }
        if (successMessage) toast.success(successMessage);
        router.refresh();
      });
    },
    [applyOptimistic, router, t]
  );

  const onStatusChange = React.useCallback(
    (id: string, status: Status) =>
      mutate(
        { type: "patch", ids: [id], changes: { status } },
        () => setIssueStatus(id, status),
        t("statusUpdated")
      ),
    [mutate, t]
  );

  const onPriorityChange = React.useCallback(
    (id: string, priority: Priority) =>
      mutate({ type: "patch", ids: [id], changes: { priority } }, () =>
        updateIssue(id, { priority })
      ),
    [mutate]
  );

  const onAssigneeChange = React.useCallback(
    (id: string, assigneeId: string | null) =>
      mutate(
        {
          type: "patch",
          ids: [id],
          changes: {
            assigneeId,
            assignee: assigneeId
              ? { id: assigneeId, name: usersById[assigneeId] ?? "" }
              : null,
          },
        },
        () => updateIssue(id, { assigneeId })
      ),
    [mutate, usersById]
  );

  const onBulkStatus = React.useCallback(
    (ids: string[], status: Status, clearSelection: () => void) => {
      clearSelection();
      mutate(
        { type: "patch", ids, changes: { status } },
        () => bulkSetStatus(ids, status),
        t("statusUpdated")
      );
    },
    [mutate, t]
  );

  const onBulkDelete = React.useCallback(
    async (ids: string[], clearSelection: () => void) => {
      const ok = await dialog.confirm({
        title: t("bulkDeleteTitle"),
        description: t("bulkDeleteDescription", { count: ids.length }),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      clearSelection();
      mutate(
        { type: "remove", ids },
        () => bulkDeleteIssues(ids),
        t("bulkDeleted")
      );
    },
    [dialog, mutate, t, tCommon]
  );

  const columns = React.useMemo<ColumnDef<GlobalIssue>[]>(
    () => [
      {
        id: "key",
        accessorFn: (i) => `${i.project.key}-${i.number}`,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnKey")} />
        ),
        cell: ({ row }) => (
          <Link
            href={issueHref(row.original)}
            className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {row.original.project.key}-{row.original.number}
          </Link>
        ),
        enableHiding: false,
        meta: { headClassName: "w-28", label: t("columnKey") },
      },
      {
        id: "title",
        accessorKey: "title",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnTitle")} />
        ),
        cell: ({ row }) => (
          <span className="flex items-center gap-2 font-medium">
            <TypeIcon type={row.original.type} />
            <Link href={issueHref(row.original)} className="hover:underline">
              {row.original.title}
            </Link>
            <LabelChips labels={row.original.labels} />
          </span>
        ),
        enableHiding: false,
        meta: { label: t("columnTitle") },
      },
      {
        id: "project",
        accessorFn: (i) => i.project.name,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnProject")} />
        ),
        cell: ({ row }) => (
          <Link
            href={`/${row.original.project.key}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            {row.original.project.name}
          </Link>
        ),
        meta: { headClassName: "w-44", label: t("columnProject") },
      },
      {
        id: "status",
        accessorKey: "status",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnStatus")} />
        ),
        cell: ({ row }) => (
          <StatusSelect
            value={row.original.status}
            onChange={(s) => onStatusChange(row.original.id, s)}
          />
        ),
        meta: { headClassName: "w-40", label: t("columnStatus") },
      },
      {
        id: "priority",
        accessorKey: "priority",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnPriority")} />
        ),
        cell: ({ row }) => (
          <PrioritySelect
            value={row.original.priority}
            onChange={(p) => onPriorityChange(row.original.id, p)}
          />
        ),
        meta: { headClassName: "w-36", label: t("columnPriority") },
      },
      {
        id: "assignee",
        accessorFn: (i) => i.assignee?.name ?? "",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnAssignee")} />
        ),
        cell: ({ row }) => (
          <AssigneeSelect
            users={users}
            value={row.original.assignee?.id ?? null}
            onChange={(a) => onAssigneeChange(row.original.id, a)}
          />
        ),
        meta: { headClassName: "w-36", label: t("columnAssignee") },
      },
      {
        id: "createdAt",
        accessorKey: "createdAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnCreated")} />
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(row.original.createdAt), {
              addSuffix: true,
              locale: dateFnsLocale,
            })}
          </span>
        ),
        meta: { headClassName: "w-32", label: t("columnCreated") },
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("columnUpdated")} />
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(row.original.updatedAt), {
              addSuffix: true,
              locale: dateFnsLocale,
            })}
          </span>
        ),
        meta: { headClassName: "w-32", label: t("columnUpdated") },
      },
    ],
    [
      dateFnsLocale,
      onAssigneeChange,
      onPriorityChange,
      onStatusChange,
      t,
      users,
    ]
  );

  const emptyState = (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <CircleDot className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t("empty")}</p>
    </div>
  );

  const isBoard = filters.view === "board";
  const boardTruncated = isBoard && total > BOARD_LIMIT;

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      <IssuesFilterBar
        filters={filters}
        onChange={setParams}
        projects={projects}
        labels={allLabels}
        leading={
          <IssuesSavedViews
            views={savedViews}
            currentParams={currentParams}
            onApply={applyView}
          />
        }
      />

      {boardTruncated && (
        <p
          role="status"
          className="shrink-0 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
        >
          {t("boardTruncated", { shown: BOARD_LIMIT, total })}
        </p>
      )}

      {isBoard ? (
        // The board has no bounded height of its own, so it gets the scroll
        // container here; columns grow and this wrapper scrolls.
        <div
          aria-busy={isPending || undefined}
          className={`flex-1 min-h-0 overflow-y-auto transition-opacity ${
            isPending ? "opacity-60" : ""
          }`}
        >
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed">{emptyState}</div>
          ) : (
            <IssueBoard
              showProject
              issues={rows.map((i) => ({
                id: i.id,
                number: i.number,
                title: i.title,
                status: i.status,
                type: i.type,
                priority: i.priority,
                keyPrefix: i.project.key,
                projectName: i.project.name,
                envName: i.environment?.name ?? null,
                assigneeName: i.assignee?.name ?? null,
                labels: i.labels,
              }))}
              onStatusChange={onStatusChange}
              swimlane={(filters.group as Swimlane) ?? "none"}
            />
          )}
        </div>
      ) : (
        <DataTable
          fillHeight
          label={t("globalTitle")}
          columns={columns}
          data={rows}
          getRowId={(i) => i.id}
          urlKey={TABLE_URL_KEY}
          initialPageSize={pageSize}
          initialSorting={DEFAULT_SORTING}
          manualRowCount={total}
          isPending={isPending}
          emptyState={emptyState}
          renderCard={(issue) => (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <TypeIcon type={issue.type} />
                <Link
                  href={issueHref(issue)}
                  className="font-mono text-xs text-muted-foreground"
                >
                  {issue.project.key}-{issue.number}
                </Link>
              </div>
              <Link href={issueHref(issue)} className="font-medium">
                {issue.title}
              </Link>
              <LabelChips labels={issue.labels} />
              <div className="flex flex-wrap items-center gap-2">
                <StatusSelect
                  value={issue.status}
                  onChange={(s) => onStatusChange(issue.id, s)}
                />
                <PrioritySelect
                  value={issue.priority}
                  onChange={(p) => onPriorityChange(issue.id, p)}
                />
                <AssigneeSelect
                  users={users}
                  value={issue.assignee?.id ?? null}
                  onChange={(a) => onAssigneeChange(issue.id, a)}
                />
              </div>
            </div>
          )}
          bulkActions={(ids, clearSelection) => (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="outline" size="sm" />}
                >
                  {t("bulkStatus")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {STATUSES.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onClick={() => onBulkStatus(ids, s, clearSelection)}
                    >
                      {t(`status.${s}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => onBulkDelete(ids, clearSelection)}
              >
                <Trash2 className="size-4" />
                {tCommon("delete")}
              </Button>
            </>
          )}
        />
      )}
    </div>
  );
}
