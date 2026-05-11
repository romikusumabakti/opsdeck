import { Skeleton } from "@/components/ui/skeleton";

export function PageHeaderSkeleton({
  withAction = true,
}: {
  withAction?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-2 min-w-0">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {withAction && <Skeleton className="h-9 w-32 shrink-0" />}
    </div>
  );
}
