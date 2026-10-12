import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  // Match the page's viewport-locked layout so the skeleton fills the same box.
  return (
    <div className="flex flex-col gap-6 lg:h-[calc(100svh-6.5rem)] lg:min-h-0">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(320px,2fr)_3fr] lg:grid-rows-[minmax(0,1fr)]">
          <div className="flex flex-col gap-3 overflow-hidden rounded-lg border p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
          <Skeleton className="min-h-[60svh] rounded-lg lg:min-h-0" />
        </div>
      </div>
    </div>
  );
}
