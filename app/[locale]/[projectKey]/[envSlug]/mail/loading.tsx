import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="min-h-[60vh] rounded-lg" />
      </div>
    </>
  );
}
