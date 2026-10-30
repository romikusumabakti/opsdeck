import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { useMe } from "@/web/api/session";
import { getCloudflareZonesQuery } from "@/web/api/tunnels";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ZonesClient } from "./-components/admin/tunnels/zones-client";

// Sits under /admin/tunnels rather than beside it so the sidebar keeps one
// section for the whole feature. The static `zones` segment takes precedence
// over the sibling `$id` route, and a tunnel id is always a UUID, so the two
// can never collide.
export const Route = createFileRoute("/$locale/_app/admin/tunnels/zones/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { tunnel: ["read"] }),
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, getCloudflareZonesQuery());
  },
  component: ZonesPage,
});

function ZonesPage() {
  const t = useTranslations("zones");
  const me = useMe();
  // tunnel:read (observers) may look; adding, editing and deleting need
  // tunnel:manage, so those controls are hidden without it.
  const canManage = canOrg(me?.orgRole, { tunnel: ["manage"] });
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          canManage ? (
            <Button
              nativeButton={false}
              render={<Link href="/admin/tunnels/zones/new" />}
            >
              <Plus className="size-4" />
              {t("addZone")}
            </Button>
          ) : undefined
        }
      />
      <ZonesClient zones={zones} canManage={canManage} />
    </>
  );
}
