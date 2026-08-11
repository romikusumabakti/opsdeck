import { Skeleton } from "@/components/ui/skeleton";

// Rendered inside the knowledge layout's <main>, so it covers the document
// pages too — clicking a node in the tree is the common navigation and that is
// what this is shaped for: toolbar, reading column, TOC rail.
const PARAGRAPHS = [
  ["w-full", "w-full", "w-4/5"],
  ["w-full", "w-11/12", "w-3/5"],
  ["w-full", "w-full", "w-2/3"],
];

export default function Loading() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 bg-background px-4 pt-4 pb-3 sm:px-6 lg:px-8">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-24 shrink-0" />
      </div>

      <div className="flex min-h-0 flex-1 justify-center gap-10 overflow-hidden px-4 sm:px-6 lg:px-8">
        <div className="flex w-full min-w-0 max-w-[46rem] flex-col gap-4 pt-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-72" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-3 w-64" />
          {PARAGRAPHS.map((lines, p) => (
            <div key={`para-${p}`} className="flex flex-col gap-2.5">
              <Skeleton className="h-5 w-40" />
              {lines.map((w, l) => (
                <Skeleton key={`line-${p}-${l}`} className={`h-4 ${w}`} />
              ))}
            </div>
          ))}
        </div>

        <aside className="hidden w-56 shrink-0 flex-col gap-2 pt-6 xl:flex">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-36" />
        </aside>
      </div>
    </div>
  );
}
