import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getCloudflareZones } from "@/actions/tunnels";
import { CloudflareZoneForm } from "@/components/cloudflare-zone-form";
import { PageHeader } from "@/components/page-header";

export default async function EditZonePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  // Zones are a handful of rows; reusing the list avoids a second action whose
  // only job would be a by-id lookup that must also strip the token.
  const zone = (await getCloudflareZones()).find((z) => z.id === id);
  if (!zone) notFound();

  const t = await getTranslations("zoneForm");

  return (
    <>
      <PageHeader title={t("editTitle")} subtitle={zone.name} />
      <div className="max-w-2xl">
        <CloudflareZoneForm mode={{ type: "edit", zone }} />
      </div>
    </>
  );
}
