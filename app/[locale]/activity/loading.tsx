import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// The feed is a plain bordered list, not a DataTable, so it gets its own shape:
// icon, sentence, relative timestamp. Overfills the viewport on purpose — the
// real list is 100 rows, so any count here is short rather than long.
const ROWS = 12;

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <ul className="flex flex-col divide-y rounded-lg border">
        {Array.from({ length: ROWS }, (_, i) => (
          <li
            key={`event-${i}`}
            className="flex items-center gap-3 px-3 py-2.5"
          >
            <Skeleton className="size-4 shrink-0 rounded-full" />
            {/* `h-5`, not `h-4`: the row is `text-sm`, so its 20px line box —
                not the 16px icon — is what sets the row height. */}
            <Skeleton className="h-5 flex-1 max-w-md" />
            <Skeleton className="h-3 w-20 shrink-0" />
          </li>
        ))}
      </ul>
    </>
  );
}
