import { getTranslations, setRequestLocale } from "next-intl/server";
import { CloudflareZoneForm } from "@/components/cloudflare-zone-form";
import { PageHeader } from "@/components/page-header";

export default async function NewZonePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("zoneForm");

  return (
    <>
      <PageHeader title={t("createTitle")} subtitle={t("createSubtitle")} />
      <div className="max-w-2xl">
        <CloudflareZoneForm mode={{ type: "create" }} />
      </div>
    </>
  );
}
