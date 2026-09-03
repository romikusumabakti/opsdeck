import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServers } from "@/actions/servers";
import { getCloudflareZones } from "@/actions/tunnels";
import { PageHeader } from "@/components/page-header";
import { TunnelForm } from "@/components/tunnel-form";

export default async function NewTunnelPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [servers, zones] = await Promise.all([
    getServers(),
    getCloudflareZones(),
  ]);
  // Without a zone there is no credential to publish hostnames with, so the
  // form has nothing to point a tunnel at.
  if (zones.length === 0) notFound();

  const t = await getTranslations("tunnelForm");

  return (
    <>
      <PageHeader title={t("createTitle")} subtitle={t("createSubtitle")} />
      <div className="max-w-2xl">
        <TunnelForm
          mode={{ type: "create" }}
          // Projected to the three fields the picker shows: `getServers` returns
          // the full row, and its encrypted password must not enter the RSC
          // payload sent to the browser.
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
