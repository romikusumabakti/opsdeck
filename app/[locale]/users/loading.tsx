import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex flex-1 min-h-0 flex-col gap-4">
        <Skeleton className="h-9 w-48 shrink-0 rounded-lg" />
        <DataTableSkeleton fillHeight columns={3} rows={8} />
      </div>
    </>
  );
}
