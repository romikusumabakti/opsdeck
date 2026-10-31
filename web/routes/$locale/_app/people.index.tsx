import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { listPeopleQuery } from "@/web/api/users";
import { loaderQuery } from "@/web/query-client";
import { PeopleClient } from "./-components/people/people-client";

export const Route = createFileRoute("/$locale/_app/people/")({
  validateSearch: (search: Record<string, unknown>): { deactivated?: "1" } => ({
    deactivated: search.deactivated === "1" ? "1" : undefined,
  }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listPeopleQuery()),
      loaderQuery(queryClient, listProjectsQuery()),
    ]);
  },
  component: PeoplePage,
});

function PeoplePage() {
  const t = useTranslations("people");
  const { deactivated } = Route.useSearch();
  const people = useSuspenseQuery(listPeopleQuery()).data;
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  return (
    <>
      <PageHeader title={t("title")} />
      <PeopleClient
        people={people}
        showDeactivated={deactivated === "1"}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  );
}
