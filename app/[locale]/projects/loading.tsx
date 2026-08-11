import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// Mirrors ProjectsOverview: search + sort row above a two-column card grid,
// each card a project header over a divided list of its environments.
const CARDS = 4;
const ENVS_PER_CARD = 3;

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-9 w-full sm:ms-auto sm:w-56" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {Array.from({ length: CARDS }, (_, c) => (
            <div
              key={`project-${c}`}
              className="rounded-xl border bg-card overflow-hidden"
            >
              <div className="flex items-start gap-2 px-4 py-3 border-b">
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {/* Project name renders at the base size (24px line box),
                        not `text-sm`, so this bar is taller than the row bars. */}
                    <Skeleton className="h-6 w-44" />
                    <Skeleton className="h-4 w-12 shrink-0" />
                  </div>
                  <Skeleton className="h-4 w-36" />
                </div>
                <Skeleton className="h-8 w-8 shrink-0 sm:w-32" />
              </div>
              <ul className="flex flex-col divide-y">
                {Array.from({ length: ENVS_PER_CARD }, (_, e) => (
                  <li
                    key={`env-${c}-${e}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <Skeleton className="size-3.5 shrink-0 rounded-full" />
                    {/* Bar heights track the line boxes they stand in for —
                        `text-sm` name (20px) over `text-xs` detail (16px), with
                        the row's own `gap-0.5` — so the row does not grow when
                        the real content lands. */}
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <Skeleton className="h-5 w-40" />
                      <Skeleton className="h-4 w-28" />
                    </div>
                    <Skeleton className="h-3 w-16 shrink-0 hidden sm:block" />
                    <Skeleton className="size-4 shrink-0" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
