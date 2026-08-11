import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type DataTableSkeletonProps = {
  columns: number;
  /**
   * Placeholder row count. Leave unset: a `fillHeight` table is bounded by the
   * viewport, so how many rows the user sees depends on their window, not on
   * the page — the default overfills and the box clips the remainder, which is
   * right at any height. Only set it for a table that sizes to its content.
   */
  rows?: number;
  withFilter?: boolean;
  // Mirror the DataTable `fillHeight` layout so the loading state occupies the
  // same box and there's no shift when real data arrives.
  fillHeight?: boolean;
};

// Enough to run past the bottom of a tall window; the container clips them.
const FILL_ROWS = 14;
const CONTENT_ROWS = 6;

export function DataTableSkeleton({
  columns,
  rows,
  withFilter = true,
  fillHeight,
}: DataTableSkeletonProps) {
  const rowCount = rows ?? (fillHeight ? FILL_ROWS : CONTENT_ROWS);
  return (
    <div className={cn("flex flex-col gap-3", fillHeight && "flex-1 min-h-0")}>
      {withFilter && (
        <div className="shrink-0 flex items-center gap-2">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-8 w-24 ml-auto" />
        </div>
      )}
      <div
        className={cn(
          "rounded-md border",
          fillHeight && "bg-card flex flex-col flex-1 min-h-0 overflow-hidden"
        )}
      >
        <Table
          containerClassName={cn(
            fillHeight && "flex-1 min-h-0 overflow-hidden"
          )}
        >
          <TableHeader>
            <TableRow>
              {Array.from({ length: columns }, (_, i) => (
                <TableHead key={`th-${i}`}>
                  <Skeleton className="h-4 w-20" />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: rowCount }, (_, r) => (
              <TableRow key={`tr-${r}`}>
                {Array.from({ length: columns }, (_, c) => (
                  <TableCell key={`td-${r}-${c}`}>
                    <Skeleton className="h-5 w-full max-w-[160px]" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
