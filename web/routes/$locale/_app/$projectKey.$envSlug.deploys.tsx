import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { listDeployTargetsQuery } from "@/web/api/deploys";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { loaderQuery } from "@/web/query-client";
import { DeploysClient } from "./-components/env/deploys/deploys-client";
import { deploysPollInterval } from "./-components/env/deploys/timeline-model";
import { HistoryPending } from "./-components/env/skeletons";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/deploys"
)({
  loader: async ({ context: { queryClient, environmentId } }) => {
    await Promise.all([
      loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId)),
      loaderQuery(queryClient, listDeployTargetsQuery(environmentId)),
    ]);
  },
  pendingComponent: HistoryPending,
  component: DeploysPage,
});

function DeploysPage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId } = Route.useRouteContext();
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const targets = useSuspenseQuery({
    ...listDeployTargetsQuery(environmentId),
    // Every 5 s while a deploy is queued or running, every 30 s while one
    // waits for the lock, so statuses move on without a manual reload.
    refetchInterval: (query) => deploysPollInterval(query.state.data),
  }).data;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <DeploysClient
      environment={environment}
      targets={targets}
      settingsHref={`/${projectKey}/${envSlug}/settings?tab=source`}
      addTargetHref={`/${projectKey}/${envSlug}/settings?tab=source&add=target`}
    />
  );
}
