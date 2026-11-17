import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { listProjectsQuery } from "@/web/api/project-catalog";

// The Assistant moved to `/assistant`. The old project page lands there with
// the project preselected. Its `?c=` and `?env=` links keep them instead: an
// environment stays preselected, a conversation opens at its own last context.
export const Route = createFileRoute("/$locale/_app/$projectKey/assistant")({
  validateSearch: z.object({
    c: z.uuid().optional().catch(undefined),
    env: z.uuid().optional().catch(undefined),
  }),
  beforeLoad: async ({
    params: { locale, projectKey },
    context: { queryClient },
    search: { c, env },
  }) => {
    const projects = await queryClient.query(listProjectsQuery());
    const project = projects.find((p) => p.key === projectKey);
    if (!project) throw notFound();
    const search = new URLSearchParams({
      ...(c ? { c } : {}),
      ...(env ? { env } : {}),
      ...(c || env ? {} : { project: project.id }),
    });
    redirect(`/assistant?${search}`, locale);
  },
});
