import { AlertTriangle, DatabaseBackup } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getBackupList } from "@/actions/backups";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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

  return (
    <div className="flex flex-col gap-6 max-w-2xl w-full mx-auto">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { dbName: project.dbName })}
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <DatabaseBackup className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("pickerTitle")}</CardTitle>
          </div>
          <CardDescription>{t("pickerDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!backups || backups.length === 0 ? (
            <EmptyState
              icon={DatabaseBackup}
              title={t("backupsNotFound")}
              description={t("backupsNotFoundDescription")}
            />
          ) : (
            <>
              <RestoreDatabase project={project} backups={backups} />
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <p>{t("dangerNote")}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
