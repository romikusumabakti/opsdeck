import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";

export default function Loading() {
  return (
    <div className="max-w-4xl py-8 mx-auto w-full px-4 flex flex-col gap-6">
      <PageHeaderSkeleton />
      <DataTableSkeleton columns={4} rows={6} />
    </div>
  );
}
