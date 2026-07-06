import { getTranslations, setRequestLocale } from "next-intl/server";
import { getBackupList } from "@/actions/backups";
import { getDatabaseList } from "@/actions/databases";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DatabasesTabs } from "./databases-tabs";

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
  const t = await getTranslations("databases");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  // Best-effort enumeration; both lists degrade gracefully so a single failing
  // probe never blocks the page from rendering the other tabs.
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

  const defaultTab =
    tab === "restore" || tab === "manage" ? tab : "backup";

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card className="max-w-3xl w-full">
        <CardContent>
          <DatabasesTabs
            project={project}
            databases={databases}
            backups={backups}
            listError={listError}
            backupListError={backupListError}
            defaultTab={defaultTab}
          />
        </CardContent>
      </Card>
    </>
  );
}
