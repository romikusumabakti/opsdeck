import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { listAppsQuery } from "@/web/api/apps";
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
    const repo = app?.components[0]?.repoFullName;
    const holding = projects.filter((p) =>
      p.environments.some((e) => e.appId === app?.id)
    );
    const target =
      projects.find((p) => p.key === project?.toUpperCase()) ??
      (holding.length === 1 ? holding[0] : undefined);
    if (!(app && target)) redirect("/projects?newEnvironment=1", locale);
    const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
    redirect(`/${target.key}/environments/new${query}`, locale);
  },
});
