import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { DashboardKpisSkeleton } from "./dashboard-kpis";
import { EnvironmentStackSkeleton } from "./environment-stack";
import { RecentActivitySkeleton } from "./recent-activity";

export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <DashboardKpisSkeleton />
      <EnvironmentStackSkeleton />
      <RecentActivitySkeleton />
    </>
  );
}
