"use client";

import {
  type ColumnDef,
  columnFilteringFeature,
  type ColumnFiltersState,
  columnVisibilityFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFns,
  flexRender,
  type PaginationState,
  type RowData,
  rowPaginationFeature,
  rowSelectionFeature,
  type RowSelectionState,
  rowSortingFeature,
  sortFns,
  type SortingState,
  tableFeatures,
  useTable,
  type ColumnVisibilityState as VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Settings2 } from "lucide-react";
import type { Column } from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import {
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TablePager } from "@/components/ui/table-pager";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// v9 requires every feature the table touches to be registered up front (row
// models included) — nothing is bundled implicitly any more. This is the one
// registration for every table in the app, so consumers never assemble their
// own. The built-in `filterFns`/`sortFns` registries are passed whole to keep
// the v8 "auto" filter/sort resolution behaviour that the column defs rely on.
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns,
  sortFns,
});

export type DataTableFeatures = typeof dataTableFeatures;

/**
 * Column definition for `DataTable`. v9 threads the feature set through every
 * public type, so callers use this alias instead of importing `ColumnDef`
 * straight from `@tanstack/react-table` and re-stating the features generic.
 */
export type DataTableColumnDef<
  TData extends RowData,
  TValue = unknown,
> = ColumnDef<DataTableFeatures, TData, TValue>;

/** Column instance as handed to a `header`/`cell` renderer. See `DataTableColumnDef`. */
export type DataTableColumn<TData extends RowData, TValue = unknown> = Column<
  DataTableFeatures,
  TData,
  TValue
>;

type DataTableProps<TData extends RowData> = {
  columns: DataTableColumnDef<TData>[];
  data: TData[];
  filterColumn?: string;
  filterPlaceholder?: string;
  emptyMessage?: string;
  initialPageSize?: number;
  /**
   * Stable row id derived from the data. Required when `bulkActions` is set so
   * selection survives re-sort/filter/optimistic mutations.
   */
  getRowId?: (row: TData) => string;
  /**
   * Render bulk-action buttons when at least one row is selected. Receives the
   * list of selected row IDs (per `getRowId`) and a `clearSelection` callback
   * so the action can reset the selection after a successful operation.
   */
  bulkActions?: (
    selectedIds: string[],
    clearSelection: () => void
  ) => React.ReactNode;
  /**
   * When `bulkActions` is set, this predicate decides whether each row can be
   * selected. Defaults to every row selectable. Use to exclude rows where the
   * action would fail (e.g. the current user in a "delete users" table).
   */
  canSelectRow?: (row: TData) => boolean;
  /**
   * When set, the filter/sort/page state is mirrored to the URL with this
   * key as a prefix (e.g. `srv_q`, `srv_s`, `srv_d`, `srv_p`, `srv_ps`). That
   * makes search results shareable and lets reloads preserve table state. Each
   * table on the same page needs a unique key so they don't fight over the
   * same params.
   */
  urlKey?: string;
  /**
   * When set, rows render as stacked cards on narrow screens (<768px) instead
   * of a horizontally-scrolling table. Receives the row data; the selection
   * checkbox (when `bulkActions` is set) is rendered by the table itself, so
   * the card only needs the row's own content. Falls back to the table layout
   * on wider screens.
   */
  renderCard?: (row: TData) => React.ReactNode;
  /**
   * When set, clicking a row (table or card layout) invokes this callback —
   * a convenience shortcut to the row's primary action (e.g. open detail).
   * Clicks landing on an interactive descendant (button, link, input,
   * checkbox, menu) are ignored so kebab menus and selection checkboxes keep
   * working. The row still exposes its full action set via those controls, so
   * this is an enhancement, not the only path.
   */
  onRowClick?: (row: TData) => void;
  /**
   * Rich empty state (icon + message + optional action) shown when there are
   * no rows — including when a filter excludes everything. Falls back to the
   * plain `emptyMessage` text when not provided.
   */
  emptyState?: React.ReactNode;
  /**
   * Fill the parent's height and confine scrolling to the table body: the
   * toolbar, table header (sticky), and pagination footer stay pinned while
   * only the rows scroll. Requires the parent to give the table a bounded
   * height (a flex column with `min-h-0`, e.g. the app `<main>`). Leave off
   * for tables that should grow with their content and let the page scroll.
   */
  fillHeight?: boolean;
  /**
   * Server-driven mode. Set to the total number of rows matching the current
   * filter and pass only the current page as `data`; the table then reports its
   * own state (sort/page) through `urlKey` and trusts the server to have
   * sorted, filtered and sliced. Leave unset for the default client-side mode,
   * where the table owns the full data set.
   */
  manualRowCount?: number;
  /**
   * True while a re-fetch triggered by the table's own state is in flight. Fades
   * the current page instead of blanking it, so paging doesn't flash empty.
   */
  isPending?: boolean;
  /**
   * Sort to assume when the URL carries none — set it to whatever order the
   * data already arrives in, so the header shows the real state instead of
   * "unsorted".
   */
  initialSorting?: SortingState;
  /**
   * Accessible name for the table element. Without it a screen reader announces
   * an unlabeled table, which is ambiguous on any page holding more than one.
   */
  label?: string;
  /**
   * Caller-owned controls (filters, view switches) rendered in the table's own
   * toolbar row, ahead of the column-visibility menu. Passing them here instead
   * of stacking a separate bar above the table keeps the page chrome to a
   * single wrapping row.
   */
  toolbar?: React.ReactNode;
  /**
   * Tighter rows for list-heavy tables: shorter cells and a shorter header, so
   * more rows fit on screen. Row height only — the type scale, cell padding and
   * toolbar spacing stay on the shared rhythm so a dense table still reads as
   * the same component as every other page's.
   */
  dense?: boolean;
  /** Columns hidden until the user turns them on in the columns menu. */
  initialColumnVisibility?: VisibilityState;
};

export function DataTable<TData extends RowData>({
  columns,
  data,
  filterColumn,
  filterPlaceholder,
  emptyMessage,
  initialPageSize = 10,
  getRowId,
  bulkActions,
  canSelectRow,
  urlKey,
  renderCard,
  onRowClick,
  emptyState,
  fillHeight,
  manualRowCount,
  isPending,
  initialSorting,
  label,
  toolbar,
  dense,
  initialColumnVisibility,
}: DataTableProps<TData>) {
  const isManual = manualRowCount != null;
  const t = useTranslations("dataTable");
  // Card layout is chosen with CSS (md: breakpoint), not a JS width hook, so the
  // correct layout renders on the first paint — no hydration flash or layout
  // shift while a resize listener catches up. Both layouts share the same row
  // model; only one is visible at any breakpoint.
  const hasCardLayout = !!renderCard;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Lazy initializers read once from the URL on mount when urlKey is set so
  // the table mirrors a shared/reloaded link. After mount the two effects below
  // keep state and URL in step in both directions.
  const [sorting, setSorting] = React.useState<SortingState>(
    () => readSortingFromParams(searchParams, urlKey) ?? initialSorting ?? []
  );
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    () => readFiltersFromParams(searchParams, urlKey, filterColumn)
  );
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(
    () => initialColumnVisibility ?? {}
  );
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [pagination, setPagination] = React.useState<PaginationState>(() =>
    readPaginationFromParams(searchParams, urlKey, initialPageSize)
  );

  const columnsWithSelect = React.useMemo<
    DataTableColumnDef<TData>[]
  >(() => {
    if (!bulkActions) return columns;
    const selectColumn: DataTableColumnDef<TData> = {
      id: "__select",
      header: ({ table }) => {
        const all = table.getIsAllPageRowsSelected();
        const some = table.getIsSomePageRowsSelected();
        return (
          <Checkbox
            checked={all}
            indeterminate={!all && some}
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(value === true)
            }
            aria-label={t("selectAll")}
          />
        );
      },
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(value === true)}
          disabled={!row.getCanSelect()}
          aria-label={t("selectRow")}
        />
      ),
      enableSorting: false,
      enableHiding: false,
      meta: { headClassName: "w-10", cellClassName: "w-10" },
    };
    return [selectColumn, ...columns];
  }, [bulkActions, columns, t]);

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns: columnsWithSelect,
    // In server-driven mode the row models are the server's job: running them
    // here would sort and slice the current page a second time, hiding rows the
    // server deliberately included. The row models are registered once on
    // `dataTableFeatures`, so the manual flags below are what switches them
    // off — v9 skips a row model whenever its `manual*` option is set.
    manualSorting: isManual,
    manualFiltering: isManual,
    manualPagination: isManual,
    rowCount: manualRowCount,
    onSortingChange: setSorting,
    onColumnFiltersChange: (updater) => {
      setColumnFilters(updater);
      // Mirrors react-table's default autoReset behavior, which we disable
      // below: a filter change should jump back to the first page so the user
      // isn't stranded on a now-out-of-range page.
      setPagination((p) => ({ ...p, pageIndex: 0 }));
    },
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    // Off because `data` arrives as a fresh reference on every parent render
    // (useOptimistic, server re-fetch after the URL-sync router.replace). With
    // the default `true`, each such re-render reset pageIndex to 0 — paging to
    // page > 1 snapped straight back to page 1. Page reset on filter change is
    // handled explicitly in onColumnFiltersChange above.
    autoResetPageIndex: false,
    enableRowSelection: bulkActions
      ? canSelectRow
        ? (row) => canSelectRow(row.original)
        : true
      : false,
    getRowId,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      pagination,
    },
  });

  // Sync URL -> state. The URL wins whenever it changes underneath the table:
  // the browser's back button, a saved view, or a sibling control that resets
  // the page because its filter changed. Without this the table would keep
  // rendering "page 3" while the server had already returned page 1.
  const paramsKey = searchParams.toString();
  const urlState = React.useMemo(() => {
    const params = new URLSearchParams(paramsKey);
    return {
      sorting: readSortingFromParams(params, urlKey),
      pagination: readPaginationFromParams(params, urlKey, initialPageSize),
      filters: readFiltersFromParams(params, urlKey, filterColumn),
    };
  }, [paramsKey, urlKey, initialPageSize, filterColumn]);
  React.useEffect(() => {
    if (!urlKey) return;
    const nextSorting = urlState.sorting ?? initialSorting ?? [];
    // Compared by value, replaced only on a real difference — so this never
    // ping-pongs with the state -> URL effect below.
    setSorting((prev) => (sameJson(prev, nextSorting) ? prev : nextSorting));
    setPagination((prev) =>
      sameJson(prev, urlState.pagination) ? prev : urlState.pagination
    );
    setColumnFilters((prev) =>
      sameJson(prev, urlState.filters) ? prev : urlState.filters
    );
  }, [urlKey, urlState, initialSorting]);

  // Sync state -> URL. Skipped on the first run because lazy initializers
  // already populated state from the URL; running it on mount would clobber
  // the existing query string with default values.
  //
  // The navigation runs inside a transition so that in server-driven mode the
  // table can fade the outgoing page while the new one is fetched, instead of
  // freezing on a click with no feedback.
  const [syncPending, startSync] = React.useTransition();
  const firstSyncRun = React.useRef(true);
  React.useEffect(() => {
    if (!urlKey) return;
    if (firstSyncRun.current) {
      firstSyncRun.current = false;
      return;
    }
    // Read window.location.search instead of the React `searchParams` because
    // multiple state changes in the same tick (e.g. filter typing also resets
    // the page) would otherwise each see a stale snapshot and clobber each
    // other. Reading the live URL keeps the merge correct.
    const params = new URLSearchParams(window.location.search);
    const filterValue =
      filterColumn != null
        ? ((columnFilters.find((f) => f.id === filterColumn)?.value as
            | string
            | undefined) ?? "")
        : "";
    writeParam(params, `${urlKey}_q`, filterValue);
    const sort = sorting[0];
    writeParam(params, `${urlKey}_s`, sort?.id ?? "");
    writeParam(params, `${urlKey}_d`, sort ? (sort.desc ? "desc" : "asc") : "");
    writeParam(
      params,
      `${urlKey}_p`,
      pagination.pageIndex > 0 ? String(pagination.pageIndex) : ""
    );
    writeParam(
      params,
      `${urlKey}_ps`,
      pagination.pageSize !== initialPageSize
        ? String(pagination.pageSize)
        : ""
    );
    const next = params.toString();
    const current = window.location.search.replace(/^\?/, "");
    if (next === current) return;
    startSync(() => {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    });
  }, [
    urlKey,
    filterColumn,
    columnFilters,
    sorting,
    pagination,
    initialPageSize,
    router,
    pathname,
  ]);

  const selectedIds = React.useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection]
  );
  const clearSelection = React.useCallback(() => setRowSelection({}), []);

  // Row-click shortcut. Ignore clicks that land on an interactive descendant
  // (kebab menu, selection checkbox, links) so those keep their own behavior;
  // only a click on the row's "empty" surface triggers navigation.
  const handleRowClick = React.useCallback(
    (original: TData) => (e: React.MouseEvent) => {
      if (!onRowClick) return;
      if (
        (e.target as HTMLElement).closest(
          'button, a, input, label, [role="checkbox"], [role="menu"], [role="menuitem"]'
        )
      ) {
        return;
      }
      onRowClick(original);
    },
    [onRowClick]
  );

  // Keyboard equivalent of the row-click shortcut. Only fires when the row
  // itself holds focus — Enter/Space typed on a nested button or link belongs
  // to that control, not to the row.
  const handleRowKeyDown = React.useCallback(
    (original: TData) => (e: React.KeyboardEvent) => {
      if (!onRowClick) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onRowClick(original);
    },
    [onRowClick]
  );

  const filterValue = filterColumn
    ? ((table.getColumn(filterColumn)?.getFilterValue() as string) ?? "")
    : "";

  const hasRows = table.getRowModel().rows.length > 0;
  const isFiltered = !!filterColumn && filterValue.trim().length > 0;

  // Two distinct empty states. A filter that excludes every row is a dead end
  // the user can recover from — offer a clear-filter affordance and echo the
  // query. A genuinely empty data set is a different message (the caller's
  // rich emptyState, e.g. a "create your first X" call to action).
  const noDataContent = emptyState ?? (
    <div className="flex h-24 items-center justify-center text-center text-muted-foreground">
      {emptyMessage ?? t("noResults")}
    </div>
  );
  const emptyContent = isFiltered ? (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <p className="text-sm text-muted-foreground">
        {t("noMatch", { query: filterValue })}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => table.getColumn(filterColumn)?.setFilterValue("")}
      >
        {t("clearFilter")}
      </Button>
    </div>
  ) : (
    noDataContent
  );
  const hasHideableColumns = table
    .getAllColumns()
    .some((c) => c.getCanHide());

  // Either source of latency dims the rows: the caller's own mutation, or the
  // table's URL-sync navigation.
  const busy = isPending || syncPending;
  const filteredCount =
    manualRowCount ?? table.getFilteredRowModel().rows.length;
  const fromIdx =
    filteredCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const toIdx = Math.min(
    (pagination.pageIndex + 1) * pagination.pageSize,
    filteredCount
  );
  const showFooter = filteredCount > 0;

  return (
    <div
      aria-busy={busy || undefined}
      className={cn("flex flex-col gap-3", fillHeight && "flex-1 min-h-0")}
    >
      {bulkActions && selectedIds.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 justify-between rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">
            {t("selectedCount", { count: selectedIds.length })}
          </span>
          <div className="flex items-center gap-2">
            {bulkActions(selectedIds, clearSelection)}
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              {t("clearSelection")}
            </Button>
          </div>
        </div>
      )}
      {(toolbar || filterColumn || hasHideableColumns) && (
        <div className="shrink-0 flex flex-wrap items-center gap-3">
          {toolbar}
          {filterColumn && (
            <Input
              placeholder={filterPlaceholder ?? t("searchPlaceholder")}
              value={filterValue}
              onChange={(e) =>
                table.getColumn(filterColumn)?.setFilterValue(e.target.value)
              }
              className="max-w-sm"
            />
          )}
          {hasHideableColumns && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn("ms-auto", hasCardLayout && "hidden md:flex")}
                  />
                }
              >
                {/* Column visibility only applies to the table layout; on the
                    card layout (narrow screens) there are no columns to toggle,
                    so the control is hidden there via CSS. */}
                <Settings2 className="size-4" />
                {t("columns")}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {table
                  .getAllColumns()
                  .filter((column) => column.getCanHide())
                  .map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) =>
                        column.toggleVisibility(!!value)
                      }
                    >
                      {column.columnDef.meta?.label ?? column.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {hasCardLayout && (
        <div
          className={cn(
            "flex flex-col gap-3 md:hidden transition-opacity",
            fillHeight && "flex-1 min-h-0 overflow-y-auto",
            busy && "opacity-60"
          )}
        >
          {hasRows ? (
            table.getRowModel().rows.map((row) => (
              <div
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                onClick={onRowClick ? handleRowClick(row.original) : undefined}
                onKeyDown={
                  onRowClick ? handleRowKeyDown(row.original) : undefined
                }
                role={onRowClick ? "link" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cn(
                  "rounded-lg border bg-card p-4 data-[state=selected]:border-primary data-[state=selected]:ring-1 data-[state=selected]:ring-primary",
                  onRowClick &&
                    "cursor-pointer hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                {bulkActions && row.getCanSelect() && (
                  <div className="mb-3 flex items-center">
                    <Checkbox
                      checked={row.getIsSelected()}
                      onCheckedChange={(value) =>
                        row.toggleSelected(value === true)
                      }
                      aria-label={t("selectRow")}
                    />
                  </div>
                )}
                {renderCard?.(row.original)}
              </div>
            ))
          ) : (
            <div className="rounded-md border">{emptyContent}</div>
          )}
        </div>
      )}
      <div
        className={cn(
          "rounded-md border transition-opacity",
          busy && "opacity-60",
          hasCardLayout && "hidden md:block",
          // A defined surface so the sticky header (bg-card) reads seamlessly
          // with the rows scrolling under it, whether the table sits on the
          // page background or inside a Card.
          fillHeight && "bg-card",
          fillHeight &&
            (hasCardLayout
              ? "md:flex md:flex-col md:flex-1 md:min-h-0 overflow-hidden"
              : "flex flex-col flex-1 min-h-0 overflow-hidden")
        )}
      >
        <Table
          aria-label={label}
          className={cn(
            dense && "[&_td]:h-9 [&_td]:py-1 [&_th]:h-8"
          )}
          containerClassName={cn(fillHeight && "flex-1 min-h-0")}
        >
          <TableHeader
            className={cn(
              // Single-<table> layout: pinning the header while the body
              // scrolls needs `sticky` (no pure-overflow equivalent inside one
              // table). bg + bottom border on the cells so rows scroll cleanly
              // underneath. The page header and pagination footer stay visible
              // via flex/overflow, not sticky.
              fillHeight &&
                "sticky top-0 z-10 [&_th]:bg-card [&_th]:border-b"
            )}
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={header.column.columnDef.meta?.headClassName}
                    aria-sort={
                      header.column.getCanSort()
                        ? header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {hasRows ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  onClick={onRowClick ? handleRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick ? handleRowKeyDown(row.original) : undefined
                  }
                  // No role override here: a <tr> must stay a `row` for the
                  // table's semantics to survive. Focusability + Enter/Space is
                  // enough to make the shortcut reachable without a pointer.
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn(
                    onRowClick &&
                      "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cell.column.columnDef.meta?.cellClassName}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columnsWithSelect.length} className="p-0">
                  {emptyContent}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {showFooter && (
        <TablePager
          pageIndex={pagination.pageIndex}
          pageSize={pagination.pageSize}
          total={filteredCount}
          onPageIndexChange={(index) => table.setPageIndex(index)}
          onPageSizeChange={(size) => table.setPageSize(size)}
        />
      )}
    </div>
  );
}

declare module "@tanstack/react-table" {
  // biome-ignore lint/correctness/noUnusedVariables: Module augmentation requires every type parameter even when unused
  interface ColumnMeta<TFeatures, TData, TValue> {
    headClassName?: string;
    cellClassName?: string;
    /**
     * Localized label for the column-visibility menu. Falls back to the raw
     * `column.id` when unset — always set it on hideable columns so the menu
     * stays translated instead of leaking internal ids.
     */
    label?: string;
  }
}

/**
 * Sortable column header button. Unlike a static sort icon, the trailing glyph
 * reflects the live sort state — ascending, descending, or unsorted — so the
 * direction is visible, not just announced via `aria-sort`. Use in a column's
 * `header` render: `header: ({ column }) => <DataTableColumnHeader column={column} title={t("colName")} />`.
 */
export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
}: {
  column: DataTableColumn<TData, TValue>;
  title: string;
}) {
  if (!column.getCanSort()) {
    return <span>{title}</span>;
  }
  const sorted = column.getIsSorted();
  const Icon =
    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ChevronsUpDown;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ms-3 h-8 data-[sorted=true]:text-foreground"
      data-sorted={sorted !== false}
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {title}
      <Icon className={cn("size-3.5", sorted === false && "opacity-50")} />
    </Button>
  );
}

/** `null` = the URL says nothing about sorting, so a default may apply. */
function readSortingFromParams(
  params: URLSearchParams,
  urlKey: string | undefined
): SortingState | null {
  if (!urlKey) return null;
  const id = params.get(`${urlKey}_s`);
  if (!id) return null;
  const desc = params.get(`${urlKey}_d`) === "desc";
  return [{ id, desc }];
}

function readFiltersFromParams(
  params: URLSearchParams,
  urlKey: string | undefined,
  filterColumn: string | undefined
): ColumnFiltersState {
  if (!urlKey || !filterColumn) return [];
  const q = params.get(`${urlKey}_q`);
  return q ? [{ id: filterColumn, value: q }] : [];
}

function readPaginationFromParams(
  params: URLSearchParams,
  urlKey: string | undefined,
  fallbackPageSize: number
): PaginationState {
  if (!urlKey) {
    return { pageIndex: 0, pageSize: fallbackPageSize };
  }
  const pageIndex = Math.max(0, Number(params.get(`${urlKey}_p`) ?? 0) || 0);
  const parsedSize = Number(params.get(`${urlKey}_ps`));
  const pageSize =
    Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : fallbackPageSize;
  return { pageIndex, pageSize };
}

/** Value equality for the small, JSON-safe table state objects. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function writeParam(
  params: URLSearchParams,
  key: string,
  value: string
): void {
  if (value === "") {
    params.delete(key);
  } else {
    params.set(key, value);
  }
}
