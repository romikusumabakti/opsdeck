import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServers } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/auth-session";
import { ServersClient } from "./servers-client";

export default async function ServersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const servers = await getServers();
  const t = await getTranslations("servers");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button render={<Link href="/servers/new" />}>
            <Plus className="size-4" />
            {t("addServer")}
          </Button>
        }
      />
      <ServersClient servers={servers} />
    </>
  );
}
