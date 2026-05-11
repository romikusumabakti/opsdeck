"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Settings2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
}: DataTableProps<TData, TValue>) {
  const t = useTranslations("dataTable");
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

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
    enableRowSelection: !!bulkActions,
    getRowId,
    initialState: {
      pagination: { pageSize: initialPageSize },
    },
    state: { sorting, columnFilters, columnVisibility, rowSelection },
  });

  const selectedIds = React.useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection]
  );
  const clearSelection = React.useCallback(() => setRowSelection({}), []);

  const filterValue = filterColumn
    ? ((table.getColumn(filterColumn)?.getFilterValue() as string) ?? "")
    : "";

  const pagination = table.getState().pagination;
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
      {(filterColumn || table.getAllColumns().some((c) => c.getCanHide())) && (
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto">
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
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(!!value)
                    }
                  >
                    {column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={header.column.columnDef.meta?.headClassName}
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
            {table.getRowModel().rows?.length ? (
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
                <TableCell
                  colSpan={columnsWithSelect.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {emptyMessage ?? t("noResults")}
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
  }
}
