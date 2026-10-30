import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { TunnelForm } from "@/components/tunnel-form";
import { getServersQuery } from "@/web/api/servers";
import { getCloudflareZonesQuery } from "@/web/api/tunnels";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/admin/tunnels/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { tunnel: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    const [, zones] = await Promise.all([
      queryClient.query(getServersQuery()),
      queryClient.query(getCloudflareZonesQuery()),
    ]);
    // Without a zone there is no credential to publish hostnames with, so the
    // form has nothing to point a tunnel at.
    if (zones.length === 0) throw notFound();
  },
  component: NewTunnelPage,
});

function NewTunnelPage() {
  const t = useTranslations("tunnelForm");
  const servers = useSuspenseQuery(getServersQuery()).data;
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;

  return (
    <>
      <PageHeader title={t("createTitle")} subtitle={t("createSubtitle")} />
      <div className="max-w-2xl">
        <TunnelForm
          mode={{ type: "create" }}
          // Projected to the three fields the picker shows.
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
