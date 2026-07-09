import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem] max-w-5xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Skeleton className="size-5 rounded-sm" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
              <div className="flex items-center gap-3 flex-wrap">
                <Skeleton className="h-8 w-36" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Skeleton className="h-9 w-20" />
                <Skeleton className="h-9 w-28" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <ul className="divide-y border-t">
              {Array.from({ length: 3 }, (_, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-2 px-6 py-3"
                >
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-14 rounded-4xl" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
