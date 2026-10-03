import { KeyRound, Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getCloudflareZones, getTunnels } from "@/actions/tunnels";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { TunnelsClient } from "./tunnels-client";

export default async function TunnelsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireOrgPage({ tunnel: ["read"] });
  // tunnel:read (observers) may look; adding, editing and deleting need
  // tunnel:manage, so those controls are hidden without it.
  const canManage = canOrg(session.user.role, { tunnel: ["manage"] });

  const [tunnels, zones] = await Promise.all([
    getTunnels(),
    getCloudflareZones(),
  ]);
  const t = await getTranslations("tunnels");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <div className="flex items-center gap-2">
            <Button
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
