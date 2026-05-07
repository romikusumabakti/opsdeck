import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";
import { BackupDatabase } from "./backup-database";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("backupDb");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl">{t("title")}</h1>
      <p>{t("description", { dbName: project.dbName })}</p>
      <BackupDatabase project={project} />
    </Card>
  );
}
