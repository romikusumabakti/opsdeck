import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { CloudflareZoneForm } from "@/components/cloudflare-zone-form";
import { PageHeader } from "@/components/page-header";
import { getCloudflareAccountQuery } from "@/web/api/cloudflare-account";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute(
  "/$locale/_app/admin/cloudflare/zones/new"
)({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { tunnel: ["manage"] });
  },
  // Whether the account's token can cover the zone decides if the zone needs
  // its own.
  loader: ({ context: { queryClient } }) =>
    queryClient.query(getCloudflareAccountQuery()),
  component: NewZonePage,
});

function NewZonePage() {
  const t = useTranslations("zoneForm");
  const account = useSuspenseQuery(getCloudflareAccountQuery()).data;
  return (
    <>
      <PageHeader title={t("createTitle")} subtitle={t("createSubtitle")} />
      <div className="max-w-2xl">
        <CloudflareZoneForm
          mode={{ type: "create" }}
          hasAccount={!!account?.hasToken}
        />
      </div>
    </>
  );
}
