import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardKpisSkeleton } from "./dashboard-kpis";
import { DatabasesTabsSkeleton } from "./databases/databases-tabs-skeleton";
import { EnvironmentStackSkeleton } from "./environment-stack";
import { RecentActivitySkeleton } from "./recent-activity";

export function DashboardPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <DashboardKpisSkeleton />
      <EnvironmentStackSkeleton />
      <RecentActivitySkeleton />
    </>
  );
}

export function SettingsPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <div className="flex flex-col gap-6 max-w-2xl w-full">
        {/* TabsList */}
        <Skeleton className="h-9 w-56 rounded-lg" />

        {/* Edit form card */}
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <FormSection fields={1} />
            <FormSection fields={7} />
            <FormSection fields={5} />
            <FormSection fields={3} />
            <div className="flex justify-end gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-28" />
            </div>
          </CardContent>
        </Card>

        {/* Duplicate card */}
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-36" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function FormSection({ fields }: { fields: number }) {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-24" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MailPending() {
  // Match the page's viewport-locked layout so the skeleton fills the same box.
  return (
    <div className="flex flex-col gap-6 lg:h-[calc(100svh-6.5rem)] lg:min-h-0">
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(320px,2fr)_3fr] lg:grid-rows-[minmax(0,1fr)]">
          <div className="flex flex-col gap-3 overflow-hidden rounded-lg border p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
          <Skeleton className="min-h-[60svh] rounded-lg lg:min-h-0" />
        </div>
      </div>
    </div>
  );
}

export function DatabasesPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="max-w-3xl w-full flex min-h-0 flex-col overflow-hidden">
        <CardContent className="flex flex-1 min-h-0 flex-col">
          <DatabasesTabsSkeleton />
        </CardContent>
      </Card>
    </>
  );
}

export function HistoryPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <DataTableSkeleton fillHeight columns={5} />
    </>
  );
}

// Without this file the nearest ancestor (`[envSlug]/loading.tsx`) takes over,
// and the issue list flashes the environment dashboard's KPI + stack skeleton —
// a layout it never resolves into.
export function IssuesPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      {/* Select, key, title, status, priority, environment, assignee, created. */}
      <DataTableSkeleton fillHeight columns={8} />
    </>
  );
}

export function MockTimePending() {
  return (
    <>
      <PageHeaderSkeleton />
      <Card className="max-w-4xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-sm" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="ml-auto h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
            {/* Clock state panel */}
            <div className="flex flex-col gap-3 rounded-md border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-4 rounded-sm" />
                  <Skeleton className="h-4 w-24" />
                </div>
                <Skeleton className="h-8 w-20" />
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            </div>

            {/* Controls */}
            <div className="flex flex-col gap-6">
              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <div className="flex flex-row items-end gap-2 flex-wrap">
                  <Skeleton className="h-10 w-48" />
                  <Skeleton className="h-10 w-32" />
                </div>
              </section>

              <Separator />

              <Skeleton className="h-4 w-40" />

              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-9 w-32" />
              </section>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export function ServicesPending() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex items-center gap-2 max-w-3xl">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <ServiceCardSkeleton key={i} />
        ))}
      </div>
    </>
  );
}

function ServiceCardSkeleton() {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Skeleton className="size-5 rounded-sm" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <Skeleton className="h-4 w-3/4" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full col-span-2" />
          <Skeleton className="h-8 w-full col-span-2" />
        </div>
      </CardContent>
    </Card>
  );
}

export function LogsPending() {
  // Match the page's viewport-locked height so the skeleton fills the same box.
  return (
    <div className="flex h-[calc(100svh-6.5rem)] min-h-0 flex-col gap-6">
      <PageHeaderSkeleton />
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-9 ml-auto" />
          <Skeleton className="h-8 w-9" />
        </div>
        <Skeleton className="flex-1 min-h-0 w-full rounded-md" />
      </div>
    </div>
  );
}
