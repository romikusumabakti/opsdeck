import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { canOrg, canProject, SETUP_PERMISSIONS } from "@/lib/permissions";
import { listAppsQuery } from "@/web/api/apps";
import {
  getMyProjectAccessQuery,
  getProjectByKeyWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { listProjectSourcesQuery } from "@/web/api/project-sources";
import { meQuery, useMe } from "@/web/api/session";
import { setupOptionsQuery } from "@/web/api/setup";
import { projectRoleOf, requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { NewEnvironmentForm } from "./-components/setup/new-environment-form";
import { sourcesModeProps } from "./-components/setup/sources-mode";

// Listing the project's sources needs environment:update. Both it and
// SETUP_PERMISSIONS sit in the engineer set today; a caller without it gets
// the page without sources mode rather than an error.
const SOURCES_READ = { environment: ["update"] } as const;

// New environment, inside a project: one page from a repository to a
// running environment. `?from=<environmentId>` starts from a copy of that
// environment, `?repo=<owner/name>` with that repository. In a project with
// sources only the source apps are offered (see sources-mode.ts).
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/environments/new"
)({
  validateSearch: (
    search: Record<string, unknown>
  ): { from?: string; repo?: string } => ({
    from:
      typeof search.from === "string" && search.from ? search.from : undefined,
    repo:
      typeof search.repo === "string" && search.repo ? search.repo : undefined,
  }),
  // Engineers of the project (QA and viewers get the not-found page); the
  // server checks placement per server.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(queryClient, project.id, SETUP_PERMISSIONS);
    return { projectId: project.id };
  },
  loader: async ({ context: { queryClient, projectId } }) => {
    const role = await projectRoleOf(queryClient, projectId);
    await Promise.all([
      loaderQuery(queryClient, listAppsQuery()),
      loaderQuery(queryClient, meQuery()),
      loaderQuery(queryClient, setupOptionsQuery(projectId)),
      canProject(role, SOURCES_READ)
        ? loaderQuery(queryClient, listProjectSourcesQuery(projectId))
        : null,
    ]);
  },
  pendingComponent: NewEnvironmentPending,
  component: NewEnvironmentPage,
});

function NewEnvironmentPage() {
  const { projectKey } = Route.useParams();
  const { from, repo } = Route.useSearch();
  const t = useTranslations("newEnvironment");
  const me = useMe();
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  const catalog = useSuspenseQuery(listAppsQuery()).data;
  const roles = useSuspenseQuery(getMyProjectAccessQuery()).data.roles;
  const projectSources =
    useQuery({
      ...listProjectSourcesQuery(project?.id ?? ""),
      enabled: !!project && canProject(roles[project.id] ?? null, SOURCES_READ),
    }).data ?? [];
  if (!project) throw notFound();
  const { apps, sources } = sourcesModeProps(catalog, projectSources);

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <NewEnvironmentForm
        project={project}
        apps={apps}
        sources={sources}
        canPublish={canOrg(me?.orgRole, { server: ["manage"] })}
        canChoosePipelines={canOrg(me?.orgRole, {
          integration: ["manage"],
        })}
        initialFrom={from}
        initialRepo={repo}
      />
    </>
  );
}

function NewEnvironmentPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="w-full max-w-3xl">
        <CardContent className="flex flex-col gap-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
