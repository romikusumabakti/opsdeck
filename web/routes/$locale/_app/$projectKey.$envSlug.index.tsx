import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import {
  getEnvironmentKpisQuery,
  getEnvironmentRunsQuery,
} from "@/web/api/runs";
import { loaderQuery } from "@/web/query-client";
import {
  DashboardKpis,
  DashboardKpisSkeleton,
} from "./-components/env/dashboard-kpis";
import { EnvironmentStack } from "./-components/env/environment-stack";
import {
  RecentActivity,
  RecentActivitySkeleton,
} from "./-components/env/recent-activity";
import { DashboardPending } from "./-components/env/skeletons";

export const Route = createFileRoute("/$locale/_app/$projectKey/$envSlug/")({
  loader: async ({ context: { queryClient, environmentId } }) => {
    // The KPIs and recent activity streamed behind Suspense: start them, but
    // let the page paint on the environment alone.
    void queryClient.prefetchQuery(getEnvironmentKpisQuery(environmentId));
    void queryClient.prefetchQuery(getEnvironmentRunsQuery(environmentId));
    await loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId));
  },
  pendingComponent: DashboardPending,
  component: DashboardPage,
});

function DashboardPage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId } = Route.useRouteContext();
  const t = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const envPath = `/${projectKey}/${envSlug}`;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: environment.name })}
      />
      <Suspense fallback={<DashboardKpisSkeleton />}>
        <DashboardKpis environmentId={environmentId} />
      </Suspense>
      <EnvironmentStack environment={environment} envPath={envPath} />
      <Suspense fallback={<RecentActivitySkeleton />}>
        <RecentActivity environmentId={environmentId} envPath={envPath} />
      </Suspense>
    </>
  );
}
