import { Skeleton } from "@/components/ui/skeleton";

// Shared placeholder for the tabs area. Used both by the route-level
// loading.tsx (whole-page navigation) and the page's <Suspense> boundary
// (streaming the SSH-probed lists) so the two never flash different shapes.
export function DatabasesTabsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {/* TabsList: three equal-width triggers */}
      <div className="flex gap-1 rounded-md bg-muted p-1">
        <Skeleton className="h-8 flex-1" />
        <Skeleton className="h-8 flex-1" />
        <Skeleton className="h-8 flex-1" />
      </div>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-9 w-40 self-end" />
    </div>
  );
}
