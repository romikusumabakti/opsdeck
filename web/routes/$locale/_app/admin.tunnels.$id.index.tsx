import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { useMe } from "@/web/api/session";
import {
  getOriginCandidatesQuery,
  getTunnelQuery,
  getTunnelRoutesQuery,
} from "@/web/api/tunnels";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { RoutesClient } from "./-components/admin/tunnels/routes-client";

export const Route = createFileRoute("/$locale/_app/admin/tunnels/$id/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { tunnel: ["read"] }),
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const tunnel = await orNotFound(queryClient.query(getTunnelQuery(id)));
    if (!tunnel) throw notFound();
    // Both reach the host over SSH; run them together so the page costs one
    // round of latency rather than two.
    await Promise.all([
      orNotFound(queryClient.query(getTunnelRoutesQuery(id))),
      orNotFound(queryClient.query(getOriginCandidatesQuery(id))),
    ]);
  },
  component: TunnelDetailPage,
});

function TunnelDetailPage() {
  const { id } = Route.useParams();
  const t = useTranslations("tunnels");
  const me = useMe();
  // tunnel:read (observers) may look; adding, editing and deleting need
  // tunnel:manage, so those controls are hidden without it.
  const canManage = canOrg(me?.orgRole, { tunnel: ["manage"] });
  const tunnel = useSuspenseQuery(getTunnelQuery(id)).data;
  const view = useSuspenseQuery(getTunnelRoutesQuery(id)).data;
  const candidates = useSuspenseQuery(getOriginCandidatesQuery(id)).data;
  if (!tunnel) return null;

  return (
    <>
      <PageHeader
        title={tunnel.name}
        subtitle={t("detailSubtitle", {
          zone: tunnel.zone.name,
          server: tunnel.server.name,
        })}
        action={
          canManage ? (
            <Button
              nativeButton={false}
              variant="outline"
              render={<Link href={`/admin/tunnels/${tunnel.id}/edit`} />}
            >
              <Pencil className="size-4" />
              {t("editRegistration")}
            </Button>
          ) : undefined
        }
      />
      <RoutesClient
        tunnel={tunnel}
        view={view}
        candidates={candidates}
        canManage={canManage}
      />
    </>
  );
}
