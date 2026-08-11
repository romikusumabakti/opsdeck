import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// No ancestor `loading.tsx` covers this route, so without it the project
// overview blocks on its six queries with the previous page still on screen.
// Shapes the default tab (Environments): key badge, tab strip, card grid.
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="h-6 w-16 -mt-2" />
      <div className="flex flex-1 min-h-0 flex-col gap-4">
        <Skeleton className="h-9 w-80 shrink-0 rounded-lg" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={`env-${i}`}
              className="flex flex-col gap-2.5 rounded-lg border p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="size-4 shrink-0" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-4 w-28" />
              </div>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
