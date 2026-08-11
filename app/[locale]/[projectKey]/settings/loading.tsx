import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// The parent `[projectKey]/loading.tsx` shapes the overview's tabbed card grid,
// which is nothing like this page — override it with the settings shape.
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <div className="flex flex-col gap-6 max-w-2xl w-full">
        {/* TabsList */}
        <Skeleton className="h-9 w-56 rounded-lg" />

        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-28" />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
