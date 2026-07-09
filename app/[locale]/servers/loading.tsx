import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <DataTableSkeleton fillHeight columns={4} rows={6} />
    </>
  );
}
