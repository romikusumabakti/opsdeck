import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-sm" />
            <Skeleton className="h-5 w-40" />
          </div>
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-9 w-32" />
          </div>
          <Skeleton className="h-14 w-full rounded-md" />
        </CardContent>
      </Card>
    </>
  );
}
