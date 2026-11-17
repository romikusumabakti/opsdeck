import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useProjectName } from "@/hooks/use-project-name";
import { stripProjectPrefix } from "@/lib/nav-path";
import { canProject } from "@/lib/permissions";
import { getAllowanceQuery } from "@/web/api/assistant";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { AssistantWorkspace } from "@/web/components/assistant/assistant-workspace";
import { requireRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { AssistantPending } from "./-components/env/skeletons";

// The environment's Assistant tab: questions about the code and issues of
// what runs in this environment, answered by the model with read-only tools.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/assistant"
)({
  beforeLoad: ({ context: { role } }) =>
    requireRole(role, { assistant: ["use"] }),
  loader: async ({ context: { queryClient, environmentId } }) => {
    await Promise.all([
      loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId)),
      loaderQuery(queryClient, getAllowanceQuery()),
    ]);
  },
  pendingComponent: AssistantPending,
  component: AssistantPage,
});

function AssistantPage() {
  const { projectKey } = Route.useParams();
  const { environmentId, role } = Route.useRouteContext();
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const projectName = useProjectName(environment?.projectId ?? "");

  if (!environment) return <p>{tCommon("environmentNotFound")}</p>;

  // Fills the app shell's `main` (its padding undone, then restored) so the
  // workspace scrolls its own panes, like the knowledge layout.
  return (
    <div className="-mx-4 -my-6 h-[calc(100svh-3.5rem)] overflow-hidden px-4 py-6 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <AssistantWorkspace
        projectId={environment.projectId}
        environmentId={environmentId}
        environmentName={stripProjectPrefix(environment.name, projectName)}
        projectKey={projectKey}
        canCreateIssue={canProject(role, { issue: ["write"] })}
      />
    </div>
  );
}
