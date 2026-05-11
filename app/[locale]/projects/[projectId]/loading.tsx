import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardKpisSkeleton } from "./dashboard-kpis";
import { RecentActivitySkeleton } from "./recent-activity";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <DashboardKpisSkeleton />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ServiceCardSkeleton extraFields={2} />
        <ServiceCardSkeleton />
        <ServiceCardSkeleton />
      </div>
      <RecentActivitySkeleton />
    </>
  );
}

function ServiceCardSkeleton({ extraFields = 0 }: { extraFields?: number }) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        {Array.from({ length: extraFields }, (_, i) => (
          <FieldSkeleton key={`extra-${i}`} />
        ))}
      </CardContent>
    </Card>
  );
}

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}
