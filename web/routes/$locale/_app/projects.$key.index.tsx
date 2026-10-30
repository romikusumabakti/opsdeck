import { createFileRoute, notFound } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { listEnvironmentsQuery } from "@/web/api/environments";

// `/projects/<environment id>`: a link from before readable URLs. Every other
// `/projects/<KEY>` is redirected before it gets here (lib/redirects.ts).
export const Route = createFileRoute("/$locale/_app/projects/$key/")({
  loader: async ({ params: { locale, key }, context: { queryClient } }) => {
    const environments = await queryClient.query(listEnvironmentsQuery());
    const environment = environments.find((e) => e.id === key);
    if (!environment) throw notFound();
    redirect(`/${environment.key}/${environment.slug}`, locale);
  },
});
