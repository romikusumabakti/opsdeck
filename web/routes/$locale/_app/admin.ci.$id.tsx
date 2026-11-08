import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { CiConnectionCard } from "@/components/ci-connection-form";
import { PageHeader } from "@/components/page-header";
import { listCiConnectionsQuery } from "@/web/api/ci-connections";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/admin/ci/$id")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const connections = await loaderQuery(
      queryClient,
      listCiConnectionsQuery()
    );
    if (!connections?.some((c) => c.id === id)) throw notFound();
  },
  component: EditCiConnectionPage,
});

function EditCiConnectionPage() {
  const { id } = Route.useParams();
  const t = useTranslations("editCi");
  const connection = useSuspenseQuery(listCiConnectionsQuery()).data.find(
    (c) => c.id === id
  );
  if (!connection) return null;

  return (
    <>
      <PageHeader
        title={t("title", { name: connection.name })}
        subtitle={t("description")}
      />
      <div className="flex flex-col gap-4 max-w-2xl w-full">
        <CiConnectionCard connection={connection} returnTo="/admin/ci" />
      </div>
    </>
  );
}
