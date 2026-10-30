import { createFileRoute, notFound } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { getProjectQuery } from "@/web/api/project-catalog";

// Creating an environment is scoped to its parent project
// (`/[KEY]/environments/new`). This keeps the old flat URL alive:
// `?project=<id>` resolves to that project's key, and a bare hit (no parent to
// infer) falls back to the projects list, where every card offers the action.
export const Route = createFileRoute("/$locale/_app/environments/new")({
  validateSearch: (
    search: Record<string, unknown>
  ): { from?: string; project?: string } => ({
    from: typeof search.from === "string" ? search.from : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  loaderDeps: ({ search: { from, project } }) => ({ from, project }),
  loader: async ({
    params: { locale },
    deps: { from, project },
    context: { queryClient },
  }) => {
    if (!project) redirect("/projects", locale);
    const parent = await queryClient.query(getProjectQuery(project));
    if (!parent) throw notFound();
    const suffix = from ? `?from=${encodeURIComponent(from)}` : "";
    redirect(`/${parent.key}/environments/new${suffix}`, locale);
  },
});
