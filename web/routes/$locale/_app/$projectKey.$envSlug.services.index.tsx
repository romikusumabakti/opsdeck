import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { ServicesClient } from "./-components/env/services-client";
import { ServicesPending } from "./-components/env/skeletons";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/services/"
)({
  loader: async ({ context: { queryClient, environmentId } }) => {
    await queryClient.query(getEnvironmentByIdQuery(environmentId));
  },
  pendingComponent: ServicesPending,
  component: ServicesPage,
});

function ServicesPage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId } = Route.useRouteContext();
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <ServicesClient
      environment={environment}
      envPath={`/${projectKey}/${envSlug}`}
    />
  );
}
