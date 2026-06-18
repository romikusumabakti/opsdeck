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
          <Skeleton className="h-4 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-9 flex-1 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
          </div>
          <Skeleton className="h-40 w-full rounded-md" />
        </CardContent>
      </Card>
    </>
  );
}
