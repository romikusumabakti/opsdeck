import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

// Home lives in a `(home)` route group purely so this file can exist: a
// `loading.tsx` directly under `[locale]` would also become the fallback for
// sign-in, setup and every other unshielded route, which render outside the
// app shell and have nothing in common with this layout.
//
// Four equal cards in a 2-column grid. The role-based ordering in page.tsx only
// permutes them, so an unordered skeleton matches either arrangement.
//
// Bars are `h-5`, not `h-4`: the rows they stand in for hold `text-sm`, whose
// 20px line box — not the 14px glyphs — is what sets the row height. A shorter
// bar makes every row 4px short and the whole card jumps when data lands.
const SECTIONS = 4;
const ROWS_PER_SECTION = 4;

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: SECTIONS }, (_, s) => (
          <div
            key={`section-${s}`}
            className="rounded-xl border bg-card overflow-hidden"
          >
            <div className="flex items-center gap-2 px-3 py-2.5 border-b">
              <Skeleton className="size-4 shrink-0" />
              <Skeleton className="h-5 w-32" />
            </div>
            <ul className="flex flex-col divide-y">
              {Array.from({ length: ROWS_PER_SECTION }, (_, r) => (
                <li
                  key={`row-${s}-${r}`}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <Skeleton className="size-3.5 shrink-0 rounded-full" />
                  <Skeleton className="h-5 flex-1 max-w-[60%]" />
                  <Skeleton className="h-3 w-20 shrink-0" />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
