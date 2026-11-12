import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { resolveStatusFilter } from "@/lib/issue-query";
import { listIssuesQuery } from "@/web/api/issues";
import { getProjectByKeyWithEnvironmentsQuery } from "@/web/api/project-catalog";
import { listAssignableUsersQuery } from "@/web/api/users";
import { requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { IssuesPending } from "./-components/env/skeletons";
import { IssuesClient } from "./-components/issues-client";

/** The list's statuses for the `status` URL param (open + in progress by default). */
const statusesFor = (status: string | undefined) =>
  resolveStatusFilter(status, "table") ?? undefined;

export const Route = createFileRoute("/$locale/_app/$projectKey/issues/")({
  validateSearch: (search: Record<string, unknown>): { status?: string } => ({
    status: typeof search.status === "string" ? search.status : undefined,
  }),
  loaderDeps: ({ search: { status } }) => ({ status }),
  // 404 when the project is unknown or invisible to the caller.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(queryClient, project.id);
  },
  loader: async ({
    deps: { status },
    params: { projectKey },
    context: { queryClient },
  }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await Promise.all([
      loaderQuery(
        queryClient,
        listIssuesQuery(project.id, statusesFor(status))
      ),
      loaderQuery(queryClient, listAssignableUsersQuery(project.id)),
    ]);
  },
  pendingComponent: IssuesPending,
  component: ProjectIssuesPage,
});

function ProjectIssuesPage() {
  const { projectKey } = Route.useParams();
  const { status } = Route.useSearch();
  const t = useTranslations("issues");
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  if (!project) throw notFound();
  const issues = useSuspenseQuery(
    listIssuesQuery(project.id, statusesFor(status))
  ).data;
  const users = useSuspenseQuery(listAssignableUsersQuery(project.id)).data;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {/* Issues are project-level, so no environment is preselected. */}
      <IssuesClient
        projectId={project.id}
        projectKey={project.key}
        currentEnvironmentId=""
        environments={project.environments.map((e) => ({
          id: e.id,
          name: e.name,
        }))}
        users={users}
        initialIssues={issues}
        status={status}
      />
    </>
  );
}
