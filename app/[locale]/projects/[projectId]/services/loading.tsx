import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex items-center gap-2 max-w-3xl">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <ServiceCardSkeleton key={i} />
        ))}
      </div>
    </>
  );
}

function ServiceCardSkeleton() {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Skeleton className="size-5 rounded-sm" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-4 w-3/4" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full col-span-2" />
          <Skeleton className="h-8 w-full col-span-2" />
        </div>
      </CardContent>
    </Card>
  );
}
