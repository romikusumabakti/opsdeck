import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="max-w-3xl w-full">
        <CardContent className="flex flex-col gap-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <div className="flex justify-end">
            <Skeleton className="h-9 w-36" />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
