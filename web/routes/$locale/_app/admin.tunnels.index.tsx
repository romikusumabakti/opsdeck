import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { useMe } from "@/web/api/session";
import { getCloudflareZonesQuery, getTunnelsQuery } from "@/web/api/tunnels";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { TunnelsClient } from "./-components/admin/tunnels/tunnels-client";

export const Route = createFileRoute("/$locale/_app/admin/tunnels/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { tunnel: ["read"] }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, getTunnelsQuery()),
      loaderQuery(queryClient, getCloudflareZonesQuery()),
    ]);
  },
  component: TunnelsPage,
});

function TunnelsPage() {
  const t = useTranslations("tunnels");
  const me = useMe();
  // tunnel:read (observers) may look; adding, editing and deleting need
  // tunnel:manage, so those controls are hidden without it.
  const canManage = canOrg(me?.orgRole, { tunnel: ["manage"] });
  const tunnels = useSuspenseQuery(getTunnelsQuery()).data;
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <div className="flex items-center gap-2">
            <Button
              nativeButton={false}
              variant="outline"
              render={<Link href="/admin/tunnels/zones" />}
            >
              <KeyRound className="size-4" />
              {t("manageZones")}
            </Button>
            {/* A tunnel can only be registered once a zone exists: the zone
                holds the credential that publishes its hostnames. */}
            {canManage ? (
              <Button
                nativeButton={zones.length === 0}
                disabled={zones.length === 0}
                render={
                  zones.length === 0 ? undefined : (
                    <Link href="/admin/tunnels/new" />
                  )
                }
              >
                <Plus className="size-4" />
                {t("addTunnel")}
              </Button>
            ) : null}
          </div>
        }
      />
      <TunnelsClient
        tunnels={tunnels}
        hasZones={zones.length > 0}
        canManage={canManage}
      />
    </>
  );
}
