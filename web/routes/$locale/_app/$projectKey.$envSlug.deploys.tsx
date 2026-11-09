import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { listDeployTargetsQuery } from "@/web/api/deploys";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { loaderQuery } from "@/web/query-client";
import { DeploysClient } from "./-components/env/deploys/deploys-client";
import { HistoryPending } from "./-components/env/skeletons";

// While a deployment is queued or running, poll so its status (and the running
// tag) moves on without a manual reload.
const ACTIVE_POLL_MS = 5000;

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
    refetchInterval: (query) =>
      query.state.data?.some((target) =>
        target.recentDeployments.some(
          (d) => d.status === "queued" || d.status === "running"
        )
      )
        ? ACTIVE_POLL_MS
        : false,
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
