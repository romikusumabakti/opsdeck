import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function FieldSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

function CardSkeleton({ extraFields = 0 }: { extraFields?: number }) {
  return (
    <Card className="flex flex-col p-4 gap-3">
      <Skeleton className="h-5 w-24" />
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton />
      {Array.from({ length: extraFields }, (_, i) => (
        <FieldSkeleton key={`extra-${i}`} />
      ))}
    </Card>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-32" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CardSkeleton extraFields={2} />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </div>
  );
}
