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
  rows?: number;
  withFilter?: boolean;
  // Mirror the DataTable `fillHeight` layout so the loading state occupies the
  // same box and there's no shift when real data arrives.
  fillHeight?: boolean;
};

export function DataTableSkeleton({
  columns,
  rows = 6,
  withFilter = true,
  fillHeight,
}: DataTableSkeletonProps) {
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
        <Table containerClassName={cn(fillHeight && "flex-1 min-h-0")}>
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
            {Array.from({ length: rows }, (_, r) => (
              <TableRow key={`tr-${r}`}>
                {Array.from({ length: columns }, (_, c) => (
                  <TableCell key={`td-${r}-${c}`}>
                    <Skeleton className="h-4 w-full max-w-[160px]" />
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
