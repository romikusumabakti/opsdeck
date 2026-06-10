"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Settings2,
} from "lucide-react";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZES = [10, 25, 50, 100] as const;

type DataTableProps<TData, TValue> = {
  columns: ColumnDef<TData, TValue>[];
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
   * Rich empty state (icon + message + optional action) shown when there are
   * no rows — including when a filter excludes everything. Falls back to the
   * plain `emptyMessage` text when not provided.
   */
  emptyState?: React.ReactNode;
};

export function DataTable<TData, TValue>({
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
  emptyState,
}: DataTableProps<TData, TValue>) {
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
  // the table mirrors a shared/reloaded link. After mount the state is
  // controlled internally; the effect below writes it back to the URL.
  const [sorting, setSorting] = React.useState<SortingState>(() =>
    readSortingFromParams(searchParams, urlKey)
  );
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    () => readFiltersFromParams(searchParams, urlKey, filterColumn)
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [pagination, setPagination] = React.useState<PaginationState>(() =>
    readPaginationFromParams(searchParams, urlKey, initialPageSize)
  );

  const columnsWithSelect = React.useMemo<ColumnDef<TData, TValue>[]>(() => {
    if (!bulkActions) return columns;
    const selectColumn: ColumnDef<TData, TValue> = {
      id: "__select",
      header: ({ table }) => {
        const all = table.getIsAllPageRowsSelected();
        const some = table.getIsSomePageRowsSelected();
        return (
          <Checkbox
            checked={all ? true : some ? "indeterminate" : false}
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

  const table = useReactTable({
    data,
    columns: columnsWithSelect,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
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

  // Sync state -> URL. Skipped on the first run because lazy initializers
  // already populated state from the URL; running it on mount would clobber
  // the existing query string with default values.
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
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
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

  const filteredCount = table.getFilteredRowModel().rows.length;
  const fromIdx =
    filteredCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const toIdx = Math.min(
    (pagination.pageIndex + 1) * pagination.pageSize,
    filteredCount
  );
  const showFooter = filteredCount > 0;

  return (
    <div className="flex flex-col gap-3">
      {bulkActions && selectedIds.length > 0 && (
        <div className="flex items-center gap-2 justify-between rounded-md border bg-muted/40 px-3 py-2">
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
      {(filterColumn || hasHideableColumns) && (
        <div className="flex items-center gap-2">
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
              <DropdownMenuTrigger asChild>
                {/* Column visibility only applies to the table layout; on the
                    card layout (narrow screens) there are no columns to toggle,
                    so the control is hidden there via CSS. */}
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("ms-auto", hasCardLayout && "hidden md:flex")}
                >
                  <Settings2 className="size-4" />
                  {t("columns")}
                </Button>
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
        <div className="flex flex-col gap-3 md:hidden">
          {hasRows ? (
            table.getRowModel().rows.map((row) => (
              <div
                key={row.id}
                data-state={row.getIsSelected() ? "selected" : undefined}
                className="rounded-lg border bg-card p-4 data-[state=selected]:border-primary data-[state=selected]:ring-1 data-[state=selected]:ring-primary"
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
      <div className={cn("rounded-md border", hasCardLayout && "hidden md:block")}>
        <Table>
          <TableHeader>
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
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 px-1">
          <div className="text-sm text-muted-foreground">
            {t("showingRange", {
              from: fromIdx,
              to: toIdx,
              total: filteredCount,
            })}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {t("rowsPerPage")}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1">
                    {pagination.pageSize}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    value={String(pagination.pageSize)}
                    onValueChange={(v) => table.setPageSize(Number(v))}
                  >
                    {PAGE_SIZES.map((size) => (
                      <DropdownMenuRadioItem key={size} value={String(size)}>
                        {size}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {table.getPageCount() > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {t("pageOf", {
                    current: pagination.pageIndex + 1,
                    total: table.getPageCount(),
                  })}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => table.firstPage()}
                  disabled={!table.getCanPreviousPage()}
                  aria-label={t("first")}
                  className="hidden sm:inline-flex"
                >
                  <ChevronsLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  aria-label={t("previous")}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  aria-label={t("next")}
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => table.lastPage()}
                  disabled={!table.getCanNextPage()}
                  aria-label={t("last")}
                  className="hidden sm:inline-flex"
                >
                  <ChevronsRight className="size-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

declare module "@tanstack/react-table" {
  // biome-ignore lint/correctness/noUnusedVariables: Module augmentation requires both type parameters even when unused
  interface ColumnMeta<TData extends unknown, TValue> {
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
export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
}: {
  column: Column<TData, TValue>;
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

function readSortingFromParams(
  params: URLSearchParams,
  urlKey: string | undefined
): SortingState {
  if (!urlKey) return [];
  const id = params.get(`${urlKey}_s`);
  if (!id) return [];
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
