import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  // Match the page's viewport-locked height so the skeleton fills the same box.
  return (
    <div className="flex h-[calc(100svh-6.5rem)] min-h-0 flex-col gap-6">
      <PageHeaderSkeleton />
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-9 ml-auto" />
          <Skeleton className="h-8 w-9" />
        </div>
        <Skeleton className="flex-1 min-h-0 w-full rounded-md" />
      </div>
    </div>
  );
}
