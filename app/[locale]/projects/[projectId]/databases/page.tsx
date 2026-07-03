import { AlertTriangle, Database } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getBackupList } from "@/actions/backups";
import { getDatabaseList } from "@/actions/databases";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ManageDatabases } from "./manage-databases";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("databases");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  // Best-effort enumeration; both lists degrade gracefully so a single failing
  // probe never blocks the page.
  const [dbResult, backupResult] = await Promise.all([
    getDatabaseList(project.id),
    getBackupList(project.id),
  ]);
  const databases = dbResult.success
    ? dbResult.data
    : [{ name: project.dbName, isDefault: true }];
  const listError = dbResult.success ? null : dbResult.error;
  const backups = backupResult.success ? backupResult.data : [];
  const backupListError = backupResult.success ? null : backupResult.error;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card className="max-w-3xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("cardTitle")}</CardTitle>
          </div>
          <CardDescription>{t("cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {listError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <p>{listError}</p>
            </div>
          )}
          <ManageDatabases
            project={project}
            databases={databases}
            backups={backups}
            backupListError={backupListError}
          />
        </CardContent>
      </Card>
    </>
  );
}
