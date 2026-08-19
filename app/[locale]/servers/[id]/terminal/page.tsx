import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerById } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
import { ServerTerminal } from "@/components/server-terminal";
import { requireAdmin } from "@/lib/auth-session";

export default async function ServerTerminalPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ cwd?: string | string[] }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  // The ticket route checks this too — this one keeps the page itself off
  // limits, so a non-admin never sees a terminal that would refuse to connect.
  await requireAdmin();

  const server = await getServerById(id);
  if (!server) notFound();

  const { cwd } = await searchParams;
  const t = await getTranslations("terminal");

  return (
    <>
      <PageHeader
        title={t("title", { name: server.name })}
        subtitle={t("subtitle", {
          username: server.username,
          host: server.host,
        })}
      />
      <ServerTerminal
        serverId={id}
        cwd={typeof cwd === "string" ? cwd : undefined}
      />
    </>
  );
}
