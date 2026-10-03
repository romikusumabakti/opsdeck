import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";
import { getBackupList } from "@/actions/backups";
import { getDatabaseList } from "@/actions/databases";
import { getEnvironmentById, listEnvironments } from "@/actions/environments";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireProjectPage } from "@/lib/authz";
import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { canProject } from "@/lib/permissions";
import { dbService } from "@/lib/services";
import { DatabasesTabs } from "./databases-tabs";
import { DatabasesTabsSkeleton } from "./databases-tabs-skeleton";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  const { tab } = await searchParams;
  setRequestLocale(locale);
  // Any project role may open the page (the Manage tab lists databases on
  // project:read); Backup and Restore only render for roles that may use them.
  const { role } = await requireProjectPage({ environmentId });
  const canBackup = canProject(role, { database: ["backup"] });
  const canRestore = canProject(role, { database: ["restore"] });
  const environment = await getEnvironmentById(environmentId);
  const t = await getTranslations("databases");
  const tCommon = await getTranslations("common");

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  const allowedTabs = [
    ...(canBackup ? (["backup"] as const) : []),
    ...(canRestore ? (["restore"] as const) : []),
    "manage" as const,
  ];
  const defaultTab =
    allowedTabs.find((allowed) => allowed === tab) ??
    allowedTabs[0] ??
    "manage";

  return (
    <>
      <PageHeader
        className="shrink-0"
        title={t("title")}
        subtitle={t("subtitle")}
      />

      {/* No `flex-1`: the card hugs its content, so the short Backup/Restore
          tabs stay compact. It still carries `min-h-0` + `overflow-hidden` so
          the tall Manage tab shrinks to the available height and scrolls its
          list internally instead of pushing the page into a scroll. */}
      <Card className="max-w-3xl w-full flex min-h-0 flex-col overflow-hidden">
        <CardContent className="flex flex-1 min-h-0 flex-col">
          {/* The DB/backup lists come from synchronous SSH probes to the remote
              DB host; streaming them behind Suspense lets the tab shell paint
              instantly instead of blocking the whole page on remote latency. */}
          <Suspense fallback={<DatabasesTabsSkeleton />}>
            <DatabasesContent
              environment={environment}
              defaultTab={defaultTab}
              canBackup={canBackup}
              canRestore={canRestore}
            />
          </Suspense>
        </CardContent>
      </Card>
    </>
  );
}

// Async boundary: everything that awaits a remote SSH probe lives here so the
// page shell above can render before any of it resolves.
async function DatabasesContent({
  environment,
  defaultTab,
  canBackup,
  canRestore,
}: {
  environment: SafeEnvironmentWithServers;
  defaultTab: "manage" | "backup" | "restore";
  canBackup: boolean;
  canRestore: boolean;
}) {
  // Best-effort enumeration; both lists degrade gracefully so a single failing
  // probe never blocks the page from rendering the other tabs. `allProjects`
  // feeds the restore tab's "source environment" picker (filtered client-side to
  // ones sharing this environment's DB location).
  const [dbResult, backupResult, allProjects] = await Promise.all([
    getDatabaseList(environment.id),
    // getBackupList needs database:backup and throws without it.
    canBackup
      ? getBackupList(environment.id)
      : Promise.resolve({ success: true as const, data: [] }),
    listEnvironments(),
  ]);
  const databases = dbResult.success
    ? dbResult.data
    : [{ name: dbService(environment).dbName ?? "", isDefault: true }];
  const listError = dbResult.success ? null : dbResult.error;
  const backups = backupResult.success ? backupResult.data : [];
  const backupListError = backupResult.success ? null : backupResult.error;

  return (
    <DatabasesTabs
      environment={environment}
      databases={databases}
      backups={backups}
      allProjects={allProjects}
      listError={listError}
      backupListError={backupListError}
      defaultTab={defaultTab}
      canBackup={canBackup}
      canRestore={canRestore}
    />
  );
}
