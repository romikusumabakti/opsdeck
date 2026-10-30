import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { getEnvironmentRunsQuery } from "@/web/api/runs";
import { loaderQuery } from "@/web/query-client";
import { HistoryClient } from "./-components/env/history-client";
import { HistoryPending } from "./-components/env/skeletons";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/history"
)({
  loader: async ({ context: { queryClient, environmentId } }) => {
    await Promise.all([
      loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId)),
      loaderQuery(queryClient, getEnvironmentRunsQuery(environmentId)),
    ]);
  },
  pendingComponent: HistoryPending,
  component: HistoryPage,
});

function HistoryPage() {
  const { environmentId } = Route.useRouteContext();
  const t = useTranslations("history");
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const runs = useSuspenseQuery(getEnvironmentRunsQuery(environmentId)).data;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <HistoryClient runs={runs} />
    </>
  );
}
