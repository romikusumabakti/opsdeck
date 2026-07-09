import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerById } from "@/actions/servers";
import { FileExplorer } from "@/components/file-explorer";
import { PageHeader } from "@/components/page-header";
import { requireAdmin } from "@/lib/auth-session";

export default async function ServerFilesPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const server = await getServerById(id);
  if (!server) notFound();

  const t = await getTranslations("explorer");

  return (
    <>
      <PageHeader
        title={t("serverFilesTitle", { name: server.name })}
        subtitle={t("serverFilesSubtitle", { root: server.sftpRoot })}
      />
      <FileExplorer
        source={{ kind: "sftp", serverId: id }}
        rootLabel={server.sftpRoot}
      />
    </>
  );
}
