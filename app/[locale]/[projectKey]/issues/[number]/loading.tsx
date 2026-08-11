import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// The detail page has no ancestor `loading.tsx`, so without this one a click
// from the issue list hangs on the old page until every query resolves.
// Mirrors `issue-detail-client`: title field, the meta grid, then the long
// prose blocks (description, comments).
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Skeleton className="h-11 w-full" />

        {/* Type, status, priority, assignee, environment, milestone. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={`meta-${i}`} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-24 w-full" />
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-28" />
          {Array.from({ length: 2 }, (_, i) => (
            <div key={`comment-${i}`} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-12 w-full" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
