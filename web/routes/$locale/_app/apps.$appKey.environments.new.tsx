import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { legacyAppServices } from "./-components/services/legacy-redirect";

// Add environment to an app (before Stage 8): the New environment page of
// `?project=<key>` with the app's first service picked. Without a project the
// projects list says to pick one.
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
  loader: async ({ params: { locale, appKey }, deps: { project } }) => {
    if (!project) redirect("/projects?newEnvironment=1", locale);
    const [first] = await legacyAppServices(appKey);
    const query = first ? `?service=${encodeURIComponent(first.key)}` : "";
    redirect(`/${project.toUpperCase()}/environments/new${query}`, locale);
  },
});
