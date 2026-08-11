"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Range readout + page size + page nav for a paged list.
 *
 * Split out of `DataTable` so a hand-rolled table (one with inline editing or
 * keyboard navigation that the generic table doesn't model) pages with exactly
 * the same control, wording and keyboard targets instead of a lookalike.
 */
export function TablePager({
  pageIndex,
  pageSize,
  total,
  onPageIndexChange,
  onPageSizeChange,
  className,
}: {
  /** Zero-based. */
  pageIndex: number;
  pageSize: number;
  /** Rows matching the current filter, across every page. */
  total: number;
  onPageIndexChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  className?: string;
}) {
  const t = useTranslations("dataTable");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(0, pageIndex), pageCount - 1);
  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = Math.min((current + 1) * pageSize, total);
  const canPrevious = current > 0;
  const canNext = current < pageCount - 1;

  return (
    <div
      className={cn(
        "shrink-0 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 px-1",
        className
      )}
    >
      <div className="text-sm text-muted-foreground">
        {t("showingRange", { from, to, total })}
      </div>
      <div
        className={cn(
          "flex items-center gap-3 flex-wrap",
          // Nothing to control when everything fits on one page: no page to
          // switch to, and no reason to shrink the page size. Drop the whole
          // cluster so the footer is just the "showing X of Y" count.
          pageCount <= 1 && "hidden"
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {t("rowsPerPage")}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" className="h-8 gap-1" />}
            >
              {pageSize}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={String(pageSize)}
                onValueChange={(v) => onPageSizeChange(Number(v))}
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
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {t("pageOf", { current: current + 1, total: pageCount })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageIndexChange(0)}
            disabled={!canPrevious}
            aria-label={t("first")}
            className="hidden sm:inline-flex"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageIndexChange(current - 1)}
            disabled={!canPrevious}
            aria-label={t("previous")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageIndexChange(current + 1)}
            disabled={!canNext}
            aria-label={t("next")}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageIndexChange(pageCount - 1)}
            disabled={!canNext}
            aria-label={t("last")}
            className="hidden sm:inline-flex"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
