import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { listVariablesQuery } from "@/web/api/variables";
import { requireRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { HistoryPending } from "./-components/env/skeletons";
import { VariablesClient } from "./-components/env/variables/variables-client";

// The environment's variables: maintainers, admins and the environment's
// owner (project variable:read, owner-aware like the API).
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/variables"
)({
  beforeLoad: ({ context: { role, isOwner } }) =>
    requireRole(role, { variable: ["read"] }, isOwner),
  loader: async ({ context: { queryClient, environmentId } }) => {
    await loaderQuery(queryClient, listVariablesQuery(environmentId));
  },
  pendingComponent: HistoryPending,
  component: VariablesPage,
});

function VariablesPage() {
  const { environmentId } = Route.useRouteContext();
  const listing = useSuspenseQuery(listVariablesQuery(environmentId)).data;
  return <VariablesClient environmentId={environmentId} listing={listing} />;
}
