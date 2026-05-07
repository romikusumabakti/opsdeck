import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type DataTableSkeletonProps = {
  columns: number;
  rows?: number;
  withFilter?: boolean;
};

export function DataTableSkeleton({
  columns,
  rows = 6,
  withFilter = true,
}: DataTableSkeletonProps) {
  return (
    <div className="flex flex-col gap-3">
      {withFilter && (
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-8 w-24 ml-auto" />
        </div>
      )}
      <div className="rounded-md border">
        <Table>
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
