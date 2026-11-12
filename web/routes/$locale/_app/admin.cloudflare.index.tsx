import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Cloud, Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { AdvancedOptions } from "@/components/advanced-options";
import { CloudflareAccountForm } from "@/components/cloudflare-account-form";
import { useDialog } from "@/components/dialog-provider";
import { PageHeader } from "@/components/page-header";
import {
  RemoteTunnelRegisterDialog,
  remoteTunnelErrorText,
} from "@/components/remote-tunnel-register-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import {
  cloudflareTunnelsQuery,
  getCloudflareAccountQuery,
} from "@/web/api/cloudflare-account";
import {
  deleteRemoteTunnel,
  remoteTunnelsQuery,
} from "@/web/api/remote-tunnels";
import { useMe } from "@/web/api/session";
import { getCloudflareZonesQuery, getTunnelsQuery } from "@/web/api/tunnels";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { TunnelsClient } from "./-components/admin/cloudflare/tunnels-client";
import { ZonesClient } from "./-components/admin/cloudflare/zones-client";

// The one Cloudflare page: the account, its DNS zones and remote tunnels, and
// the legacy locally configured tunnels under Advanced options.
export const Route = createFileRoute("/$locale/_app/admin/cloudflare/")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { server: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, getCloudflareAccountQuery()),
      loaderQuery(queryClient, getCloudflareZonesQuery()),
      loaderQuery(queryClient, getTunnelsQuery()),
    ]);
  },
  component: CloudflarePage,
});

function CloudflarePage() {
  const t = useTranslations("cloudflareAccount");
  const account = useSuspenseQuery(getCloudflareAccountQuery()).data;
  const me = useMe();
  // Zones and local tunnels keep their own gate: adding, editing and deleting
  // need tunnel:manage.
  const canManage = canOrg(me?.orgRole, { tunnel: ["manage"] });

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex flex-col gap-4 max-w-4xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cloud className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <CloudflareAccountForm account={account} />
          </CardContent>
        </Card>
        <ZonesCard canManage={canManage} />
        {account?.hasToken && <TunnelsCard />}
        <AdvancedOptions>
          <LocalTunnelsCard canManage={canManage} />
        </AdvancedOptions>
      </div>
    </>
  );
}

function ZonesCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations("zones");
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;
  return (
    <Card id="zones">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
        {canManage && zones.length > 0 && (
          <CardAction>
            <Button
              size="sm"
              nativeButton={false}
              render={<Link href="/admin/cloudflare/zones/new" />}
            >
              <Plus className="size-4" />
              {t("addZone")}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <ZonesClient zones={zones} canManage={canManage} />
      </CardContent>
    </Card>
  );
}

// Tunnels whose ingress lives in a cloudflared config.yml on the server,
// edited over SSH. Kept until the last of them moves to a remote tunnel.
function LocalTunnelsCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations("cloudflareAccount");
  const tTunnels = useTranslations("tunnels");
  const tunnels = useSuspenseQuery(getTunnelsQuery()).data;
  const zones = useSuspenseQuery(getCloudflareZonesQuery()).data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("localTunnelsTitle")}</CardTitle>
        <CardDescription>{t("localTunnelsDescription")}</CardDescription>
        {/* A tunnel can only be registered once a zone exists: its hostnames
            are published in one. */}
        {canManage && tunnels.length > 0 && (
          <CardAction>
            <Button
              size="sm"
              nativeButton={zones.length === 0}
              disabled={zones.length === 0}
              render={
                zones.length === 0 ? undefined : (
                  <Link href="/admin/cloudflare/local-tunnels/new" />
                )
              }
            >
              <Plus className="size-4" />
              {tTunnels("addTunnel")}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <TunnelsClient
          tunnels={tunnels}
          hasZones={zones.length > 0}
          canManage={canManage}
        />
      </CardContent>
    </Card>
  );
}

function TunnelsCard() {
  const t = useTranslations("cloudflareAccount");
  const tDomains = useTranslations("domains");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const tunnels = useQuery(cloudflareTunnelsQuery());
  const registered = useQuery(remoteTunnelsQuery()).data ?? [];
  const [registering, setRegistering] = React.useState<{
    id: string;
    name: string;
  } | null>(null);

  async function onRemove(row: (typeof registered)[number]) {
    const ok = await dialog.confirm({
      title: t("removeTitle"),
      description: t("removeDescription", {
        tunnel: row.name,
        server: row.serverName,
      }),
      confirmText: t("remove"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteRemoteTunnel(row.id);
      toast.success(t("removed"));
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(remoteTunnelErrorText(error, tDomains));
        return;
      }
      throw error;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("tunnelsTitle")}</CardTitle>
        <CardDescription>{t("tunnelsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {tunnels.isPending && (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}
        {tunnels.isError && (
          <p className="text-sm text-destructive">{tunnels.error.message}</p>
        )}
        {tunnels.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("tunnelsEmpty")}</p>
        )}
        {tunnels.data && tunnels.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colManagement")}</TableHead>
                <TableHead>{t("colServer")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tunnels.data.map((tunnel) => {
                const row = registered.find((r) => r.tunnelId === tunnel.id);
                return (
                  <TableRow key={tunnel.id}>
                    <TableCell>
                      <div className="font-medium">{tunnel.name}</div>
                      <div className="font-mono text-sm text-muted-foreground">
                        {tunnel.id}
                      </div>
                    </TableCell>
                    <TableCell>{tunnel.status}</TableCell>
                    <TableCell>
                      <Badge
                        variant={tunnel.remoteConfig ? "secondary" : "outline"}
                      >
                        {tunnel.remoteConfig ? t("remote") : t("local")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row ? (
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div>{row.serverName}</div>
                            <div className="font-mono text-sm text-muted-foreground">
                              {row.originHost}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={row.boundCount > 0}
                            title={
                              row.boundCount > 0 ? t("removeBound") : undefined
                            }
                            onClick={() => onRemove(row)}
                          >
                            {t("remove")}
                          </Button>
                        </div>
                      ) : tunnel.remoteConfig ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setRegistering({ id: tunnel.id, name: tunnel.name })
                          }
                        >
                          {t("register")}
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t("notRegistrable")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {registering && (
          <RemoteTunnelRegisterDialog
            open
            onOpenChange={(open) => !open && setRegistering(null)}
            tunnel={registering}
            takenServerIds={registered.map((r) => r.serverId)}
          />
        )}
      </CardContent>
    </Card>
  );
}
