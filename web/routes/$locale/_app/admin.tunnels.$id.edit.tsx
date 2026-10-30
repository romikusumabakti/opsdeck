import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { TunnelForm } from "@/components/tunnel-form";
import { getServersQuery } from "@/web/api/servers";
import { getCloudflareZonesQuery, getTunnelQuery } from "@/web/api/tunnels";
import { orNotFound, requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/admin/tunnels/$id/edit")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { tunnel: ["manage"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const [tunnel] = await Promise.all([
      orNotFound(queryClient.query(getTunnelQuery(id))),
      queryClient.query(getServersQuery()),
      queryClient.query(getCloudflareZonesQuery()),
    ]);
    if (!tunnel) throw notFound();
  },
  component: EditTunnelPage,
});

function EditTunnelPage() {
  const { id } = Route.useParams();
  const t = useTranslations("tunnelForm");
  const tunnel = useSuspenseQuery(getTunnelQuery(id)).data;
  const servers = useSuspenseQuery(getServersQuery()).data;
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;
  if (!tunnel) return null;

  return (
    <>
      <PageHeader title={t("editTitle")} subtitle={t("editSubtitle")} />
      <div className="max-w-2xl">
        <TunnelForm
          mode={{ type: "edit", tunnel }}
          servers={servers.map((s) => ({
            id: s.id,
            name: s.name,
            host: s.host,
          }))}
          zones={zones.map((z) => ({ id: z.id, name: z.name }))}
        />
      </div>
    </>
  );
}
