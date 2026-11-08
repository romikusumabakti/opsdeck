import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { addEnvironmentHref, listAppsQuery } from "@/web/api/apps";
import { listProjectsWithEnvironmentsQuery } from "@/web/api/project-catalog";

// Add environment to an app is now the project's New environment page with
// the app's repository preselected: in the one project that holds the app's
// environments (or `?project=<key>`), else the projects list.
export const Route = createFileRoute(
  "/$locale/_app/apps/$appKey/environments/new"
)({
  validateSearch: (search: Record<string, unknown>): { project?: string } => ({
    project:
      typeof search.project === "string" && search.project
        ? search.project
        : undefined,
  }),
  loaderDeps: ({ search: { project } }) => ({ project }),
  loader: async ({
    params: { locale, appKey },
    deps: { project },
    context: { queryClient },
  }) => {
    const [apps, projects] = await Promise.all([
      queryClient.query(listAppsQuery()),
      queryClient.query(listProjectsWithEnvironmentsQuery()),
    ]);
    const app = apps.find((a) => a.appKey === appKey);
    redirect(
      app
        ? addEnvironmentHref(app, projects, project)
        : "/projects?newEnvironment=1",
      locale
    );
  },
});
