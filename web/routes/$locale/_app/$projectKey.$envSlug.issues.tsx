import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { resolveStatusFilter } from "@/lib/issue-query";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { listIssuesQuery } from "@/web/api/issues";
import { listMilestonesQuery } from "@/web/api/milestones";
import { getProjectWithEnvironmentsQuery } from "@/web/api/project-catalog";
import { listAssignableUsersQuery } from "@/web/api/users";
import { loaderQuery } from "@/web/query-client";
import { IssuesPending } from "./-components/env/skeletons";
import { IssuesClient } from "./-components/issues-client";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/issues"
)({
  validateSearch: (search: Record<string, unknown>): { status?: string } => ({
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  loaderDeps: ({ search: { status } }) => ({ status }),
  // The issues belong to the environment's parent project and are shared
  // across its environments, so the project id comes from the environment.
  loader: async ({
    deps: { status },
    context: { queryClient, environmentId },
  }) => {
    const env = await queryClient.query(getEnvironmentByIdQuery(environmentId));
    if (!env) return;
    await Promise.all([
      loaderQuery(queryClient, getProjectWithEnvironmentsQuery(env.projectId)),
      loaderQuery(
        queryClient,
        listIssuesQuery(env.projectId, statusesFor(status))
      ),
      loaderQuery(queryClient, listAssignableUsersQuery(env.projectId)),
      loaderQuery(queryClient, listMilestonesQuery(env.projectId)),
    ]);
  },
  pendingComponent: IssuesPending,
  component: EnvironmentIssuesPage,
});

/** The list's statuses for the `status` URL param (open + in progress by default). */
const statusesFor = (status: string | undefined) =>
  resolveStatusFilter(status, "table") ?? undefined;

function EnvironmentIssuesPage() {
  const { environmentId } = Route.useRouteContext();
  const { status } = Route.useSearch();
  const tCommon = useTranslations("common");
  const env = useSuspenseQuery(getEnvironmentByIdQuery(environmentId)).data;
  if (!env) return <p>{tCommon("environmentNotFound")}</p>;
  return (
    <EnvironmentIssues
      projectId={env.projectId}
      environmentId={env.id}
      status={status}
    />
  );
}

function EnvironmentIssues({
  projectId,
  environmentId,
  status,
}: {
  projectId: string;
  environmentId: string;
  status: string | undefined;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");
  const project = useSuspenseQuery(
    getProjectWithEnvironmentsQuery(projectId)
  ).data;
  const issues = useSuspenseQuery(
    listIssuesQuery(projectId, statusesFor(status))
  ).data;
  const users = useSuspenseQuery(listAssignableUsersQuery(projectId)).data;
  const milestones = useSuspenseQuery(listMilestonesQuery(projectId)).data;
  if (!project) return <p>{tCommon("projectNotFound")}</p>;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <IssuesClient
        projectId={project.id}
        projectKey={project.key}
        currentEnvironmentId={environmentId}
        environments={project.environments.map((e) => ({
          id: e.id,
          name: e.name,
        }))}
        users={users}
        milestones={milestones.map((m) => ({ id: m.id, name: m.name }))}
        initialIssues={issues}
        status={status}
      />
    </>
  );
}
