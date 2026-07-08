import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <Card className="max-w-4xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-sm" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="ml-auto h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
            {/* Clock state panel */}
            <div className="flex flex-col gap-3 rounded-md border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-4 rounded-sm" />
                  <Skeleton className="h-4 w-24" />
                </div>
                <Skeleton className="h-8 w-20" />
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            </div>

            {/* Controls */}
            <div className="flex flex-col gap-6">
              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <div className="flex flex-row items-end gap-2 flex-wrap">
                  <Skeleton className="h-10 w-48" />
                  <Skeleton className="h-10 w-32" />
                </div>
              </section>

              <Separator />

              <Skeleton className="h-4 w-40" />

              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-9 w-32" />
              </section>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
