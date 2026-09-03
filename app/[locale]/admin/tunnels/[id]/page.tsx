import { Pencil } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  getOriginCandidates,
  getTunnel,
  getTunnelRoutes,
} from "@/actions/tunnels";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { RoutesClient } from "./routes-client";

export default async function TunnelDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const tunnel = await getTunnel(id);
  if (!tunnel) notFound();

  // Both reach the host over SSH; run them together so the page costs one
  // round of latency rather than two.
  const [view, candidates] = await Promise.all([
    getTunnelRoutes(id),
    getOriginCandidates(id),
  ]);
  const t = await getTranslations("tunnels");

  return (
    <>
      <PageHeader
        title={tunnel.name}
        subtitle={t("detailSubtitle", {
          zone: tunnel.zone.name,
          server: tunnel.server.name,
        })}
        action={
          <Button
            variant="outline"
            render={<Link href={`/admin/tunnels/${tunnel.id}/edit`} />}
          >
            <Pencil className="size-4" />
            {t("editRegistration")}
          </Button>
        }
      />
      <RoutesClient tunnel={tunnel} view={view} candidates={candidates} />
    </>
  );
}
