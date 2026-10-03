import { Skeleton } from "@/components/ui/skeleton";

// Bars are `h-5`, not `h-4`: the rows they stand in for hold `text-sm`, whose
// 20px line box — not the 14px glyphs — is what sets the row height.
function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Skeleton className="size-4 shrink-0" />
        <Skeleton className="h-5 w-32" />
      </div>
      <ul className="flex flex-col divide-y">
        {Array.from({ length: rows }, (_, r) => (
          <li key={`row-${r}`} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="h-5 max-w-[60%] flex-1" />
            <Skeleton className="h-3 w-16 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MainColumnSkeleton() {
  return (
    <>
      <CardSkeleton rows={3} />
      <CardSkeleton rows={5} />
    </>
  );
}

export function RailSkeleton() {
  return (
    <>
      <Skeleton className="h-10 w-full rounded-xl" />
      <CardSkeleton rows={4} />
    </>
  );
}
