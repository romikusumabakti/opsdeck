import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getS3Connection } from "@/actions/s3-connections";
import { FileExplorer } from "@/components/file-explorer";
import { PageHeader } from "@/components/page-header";
import { requireAdmin } from "@/lib/auth-session";

export default async function StorageFilesPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const connection = await getS3Connection(id);
  if (!connection) notFound();

  const t = await getTranslations("explorer");

  return (
    <>
      <PageHeader
        title={t("storageFilesTitle", { name: connection.name })}
        subtitle={t("storageFilesSubtitle", { bucket: connection.bucket })}
      />
      <FileExplorer
        source={{ kind: "s3", connectionId: id }}
        rootLabel={connection.bucket}
      />
    </>
  );
}
