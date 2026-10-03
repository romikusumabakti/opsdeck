import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { MainColumnSkeleton, RailSkeleton } from "./_components/skeletons";

// Home lives in a `(home)` route group purely so this file can exist: a
// `loading.tsx` directly under `[locale]` would also become the fallback for
// sign-in, setup and every other unshielded route, which render outside the
// app shell and have nothing in common with this layout.
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <MainColumnSkeleton />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <RailSkeleton />
        </div>
      </div>
    </>
  );
}
