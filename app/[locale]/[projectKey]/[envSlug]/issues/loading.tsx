import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";

// Without this file the nearest ancestor (`[envSlug]/loading.tsx`) takes over,
// and the issue list flashes the environment dashboard's KPI + stack skeleton —
// a layout it never resolves into.
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      {/* Select, key, title, status, priority, environment, assignee, created. */}
      <DataTableSkeleton fillHeight columns={8} />
    </>
  );
}
