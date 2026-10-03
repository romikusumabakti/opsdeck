import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServers } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { ServersClient } from "./servers-client";

export default async function ServersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await requireOrgPage({ server: ["read"] });
  // server:read (observers) lists servers; managing, the terminal and the file
  // browser each need their own statement, so their controls are hidden too.
  const role = session.user.role;
  const can = {
    manage: canOrg(role, { server: ["manage"] }),
    terminal: canOrg(role, { server: ["terminal"] }),
    files: canOrg(role, { server: ["files"] }),
  };

  const servers = await getServers();
  const t = await getTranslations("servers");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          can.manage ? (
            <Button render={<Link href="/servers/new" />}>
              <Plus className="size-4" />
              {t("addServer")}
            </Button>
          ) : undefined
        }
      />
      <ServersClient servers={servers} can={can} />
    </>
  );
}
