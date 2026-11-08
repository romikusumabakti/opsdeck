import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { CloudflareZoneForm } from "@/components/cloudflare-zone-form";
import { PageHeader } from "@/components/page-header";
import { getCloudflareAccountQuery } from "@/web/api/cloudflare-account";
import { getCloudflareZonesQuery } from "@/web/api/tunnels";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute(
  "/$locale/_app/admin/cloudflare/zones/$id"
)({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { tunnel: ["manage"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    // Zones are a handful of rows; reusing the list avoids a by-id lookup that
    // must also strip the token.
    const [zones] = await Promise.all([
      queryClient.query(getCloudflareZonesQuery()),
      queryClient.query(getCloudflareAccountQuery()),
    ]);
    if (!zones.some((z) => z.id === id)) throw notFound();
  },
  component: EditZonePage,
});

function EditZonePage() {
  const { id } = Route.useParams();
  const t = useTranslations("zoneForm");
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;
  const account = useSuspenseQuery(getCloudflareAccountQuery()).data;
  const zone = zones.find((z) => z.id === id);
  if (!zone) return null;

  return (
    <>
      <PageHeader title={t("editTitle")} subtitle={zone.name} />
      <div className="max-w-2xl">
        <CloudflareZoneForm
          mode={{ type: "edit", zone }}
          hasAccount={!!account?.hasToken}
        />
      </div>
    </>
  );
}
