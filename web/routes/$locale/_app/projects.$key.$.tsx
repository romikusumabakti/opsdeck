import { createFileRoute, notFound } from "@tanstack/react-router";
import { redirect } from "@/i18n/navigation";
import { listEnvironmentsQuery } from "@/web/api/environments";

// `/projects/<environment id>/services` and the like: the same legacy links as
// `projects.$key.index`, with a path behind them that is kept.
export const Route = createFileRoute("/$locale/_app/projects/$key/$")({
  loader: async ({
    params: { locale, key, _splat },
    context: { queryClient },
  }) => {
    const environments = await queryClient.query(listEnvironmentsQuery());
    const environment = environments.find((e) => e.id === key);
    if (!environment) throw notFound();
    redirect(`/${environment.key}/${environment.slug}/${_splat ?? ""}`, locale);
  },
});
