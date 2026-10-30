import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
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
  // The issues belong to the environment's parent project and are shared
  // across its environments, so the project id comes from the environment.
  loader: async ({ context: { queryClient, environmentId } }) => {
    const env = await queryClient.query(getEnvironmentByIdQuery(environmentId));
    if (!env) return;
    await Promise.all([
      loaderQuery(queryClient, getProjectWithEnvironmentsQuery(env.projectId)),
      loaderQuery(queryClient, listIssuesQuery(env.projectId)),
      loaderQuery(queryClient, listAssignableUsersQuery(env.projectId)),
      loaderQuery(queryClient, listMilestonesQuery(env.projectId)),
    ]);
  },
  pendingComponent: IssuesPending,
  component: EnvironmentIssuesPage,
});

function EnvironmentIssuesPage() {
  const { environmentId } = Route.useRouteContext();
  const tCommon = useTranslations("common");
  const env = useSuspenseQuery(getEnvironmentByIdQuery(environmentId)).data;
  if (!env) return <p>{tCommon("environmentNotFound")}</p>;
  return <EnvironmentIssues projectId={env.projectId} environmentId={env.id} />;
}

function EnvironmentIssues({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");
  const project = useSuspenseQuery(
    getProjectWithEnvironmentsQuery(projectId)
  ).data;
  const issues = useSuspenseQuery(listIssuesQuery(projectId)).data;
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
      />
    </>
  );
}
