import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServers } from "@/actions/servers";
import { getCloudflareZones, getTunnel } from "@/actions/tunnels";
import { PageHeader } from "@/components/page-header";
import { TunnelForm } from "@/components/tunnel-form";

export default async function EditTunnelPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const [tunnel, servers, zones] = await Promise.all([
    getTunnel(id),
    getServers(),
    getCloudflareZones(),
  ]);
  if (!tunnel) notFound();

  const t = await getTranslations("tunnelForm");

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
