import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getCloudflareZones } from "@/actions/tunnels";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ZonesClient } from "./zones-client";

// Sits under /admin/tunnels rather than beside it so the sidebar keeps one
// section for the whole feature. The static `zones` segment takes precedence
// over the sibling `[id]` route, and a tunnel id is always a UUID, so the two
// can never collide.
export default async function ZonesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const zones = await getCloudflareZones();
  const t = await getTranslations("zones");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button render={<Link href="/admin/tunnels/zones/new" />}>
            <Plus className="size-4" />
            {t("addZone")}
          </Button>
        }
      />
      <ZonesClient zones={zones} />
    </>
  );
}
