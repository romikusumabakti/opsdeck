import { getTranslations, setRequestLocale } from "next-intl/server";
import { getBackupList } from "@/actions/backups";
import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";
import { RestoreDatabase } from "./restore-database";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("restoreDb");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const backups = (await getBackupList(project)).data;

  if (!backups) {
    return <p>{t("backupsNotFound")}</p>;
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl">{t("title")}</h1>
      <RestoreDatabase backups={backups} />
    </Card>
  );
}
