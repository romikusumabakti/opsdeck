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

  const result = await getBackupList(project);
  const backups = result.success ? result.data : [];
  const listError = result.success ? null : result.error;

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { dbName: project.dbName })}
      />

      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <DatabaseBackup className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("pickerTitle")}</CardTitle>
          </div>
          <CardDescription>{t("pickerDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {listError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <p>{listError}</p>
            </div>
          ) : backups.length === 0 ? (
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
    </>
  );
}
