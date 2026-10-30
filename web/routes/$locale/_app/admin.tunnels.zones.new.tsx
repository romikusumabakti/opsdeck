import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { CloudflareZoneForm } from "@/components/cloudflare-zone-form";
import { PageHeader } from "@/components/page-header";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/admin/tunnels/zones/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { tunnel: ["manage"] });
  },
  component: NewZonePage,
});

function NewZonePage() {
  const t = useTranslations("zoneForm");
  return (
    <>
      <PageHeader title={t("createTitle")} subtitle={t("createSubtitle")} />
      <div className="max-w-2xl">
        <CloudflareZoneForm mode={{ type: "create" }} />
      </div>
    </>
  );
}
