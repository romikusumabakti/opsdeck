import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";

// The `loading.tsx` of the servers, storage and Jira connection lists: a page
// header and a table.
export function ListPending({ columns = 4 }: { columns?: number }) {
  return (
    <>
      <PageHeaderSkeleton />
      <DataTableSkeleton fillHeight columns={columns} />
    </>
  );
}
