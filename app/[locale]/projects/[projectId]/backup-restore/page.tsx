import { getTranslations, setRequestLocale } from "next-intl/server";
import { getBackupList } from "@/actions/backups";
import { getDatabaseList } from "@/actions/databases";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { BackupRestoreTabs } from "./backup-restore-tabs";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; projectId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale, projectId } = await params;
  const { tab } = await searchParams;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("backupRestore");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  // Best-effort enumeration; both lists degrade gracefully so a single failing
  // probe never blocks the page from rendering the other tab.
  const [dbResult, backupResult] = await Promise.all([
    getDatabaseList(project.id),
    getBackupList(project.id),
  ]);
  const databases = dbResult.success
    ? dbResult.data
    : [{ name: project.dbName, isDefault: true }];
  const backups = backupResult.success ? backupResult.data : [];
  const listError = backupResult.success ? null : backupResult.error;

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { dbName: project.dbName })}
      />

      <Card className="max-w-3xl w-full">
        <CardContent>
          <BackupRestoreTabs
            project={project}
            databases={databases}
            backups={backups}
            listError={listError}
            defaultTab={tab === "restore" ? "restore" : "backup"}
          />
        </CardContent>
      </Card>
    </>
  );
}
