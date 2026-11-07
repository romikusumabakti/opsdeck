import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { canOrg } from "@/lib/permissions";
import { listAppsQuery, projectsToAddEnvironmentTo } from "@/web/api/apps";
import {
  getMyProjectAccessQuery,
  listProjectsWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { meQuery, useMe } from "@/web/api/session";
import { loaderQuery } from "@/web/query-client";
import { AddEnvironmentForm } from "./-components/setup/add-environment-form";

// Add an environment to an app: one page with collapsible sections, prefilled
// by copying another environment of the app. `?project=<key>` preselects the
// project.
export const Route = createFileRoute(
  "/$locale/_app/apps/$appKey/environments/new"
)({
  validateSearch: (search: Record<string, unknown>): { project?: string } => ({
    project:
      typeof search.project === "string" && search.project
        ? search.project
        : undefined,
  }),
  // Only for those who can create environments in some project; the setup
  // API checks the target project again.
  beforeLoad: async ({ params: { appKey }, context: { queryClient } }) => {
    const [apps, access] = await Promise.all([
      loaderQuery(queryClient, listAppsQuery()),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
      loaderQuery(queryClient, meQuery()),
    ]);
    if (!apps?.some((app) => app.appKey === appKey)) throw notFound();
    if (
      !access ||
      projectsToAddEnvironmentTo(
        Object.keys(access.roles).map((id) => ({ id })),
        access.roles
      ).length === 0
    ) {
      throw notFound();
    }
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listProjectsWithEnvironmentsQuery());
  },
  component: AddEnvironmentPage,
});

function AddEnvironmentPage() {
  const { appKey } = Route.useParams();
  const { project } = Route.useSearch();
  const t = useTranslations("setupWizard.addEnvironment");
  const me = useMe();
  const app = useSuspenseQuery(listAppsQuery()).data.find(
    (a) => a.appKey === appKey
  );
  const projects = useSuspenseQuery(listProjectsWithEnvironmentsQuery()).data;
  const access = useSuspenseQuery(getMyProjectAccessQuery()).data;
  if (!app) return null;

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { app: app.name })}
      />
      <AddEnvironmentForm
        app={app}
        projects={projectsToAddEnvironmentTo(projects, access.roles)}
        sourceProjects={projects}
        canPublish={canOrg(me?.orgRole, { server: ["manage"] })}
        initialProjectKey={project}
      />
    </>
  );
}
