import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServers } from "@/actions/servers";
import { Button } from "@/components/ui/button";
import { Link, redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { ServersClient } from "./servers-client";

export default async function ServersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (!session) await redirect("/sign-in?redirect=/servers");

  const servers = await getServers();
  const t = await getTranslations("servers");

  return (
    <div className="max-w-4xl py-8 mx-auto w-full px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Button asChild>
          <Link href="/servers/new">
            <Plus className="size-4" />
            {t("addServer")}
          </Link>
        </Button>
      </div>
      <ServersClient servers={servers} />
    </div>
  );
}
