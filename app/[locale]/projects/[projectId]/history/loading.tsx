import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <DataTableSkeleton columns={3} rows={6} />
    </div>
  );
}
