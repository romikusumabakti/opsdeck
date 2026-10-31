import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { canAnyProject, canProject } from "@/lib/permissions";
import { dbService } from "@/lib/services";
import { type getBackupList, getBackupListQuery } from "@/web/api/backups";
import { getDatabaseListQuery } from "@/web/api/databases";
import {
  type EnvironmentWithServers,
  getEnvironmentByIdQuery,
  listEnvironmentsQuery,
} from "@/web/api/environments";
import { loaderQuery } from "@/web/query-client";
import { DatabasesTabs } from "./-components/env/databases/databases-tabs";
import { DatabasesTabsSkeleton } from "./-components/env/databases/databases-tabs-skeleton";
import { DatabasesPending } from "./-components/env/skeletons";

// Stands in for the backup list when the role can neither back up nor restore:
// nothing to fetch.
const NO_BACKUPS = queryOptions({
  queryKey: ["backups", "getBackupList", ["none"] as [string]],
  queryFn: (): ReturnType<typeof getBackupList> =>
    Promise.resolve({ success: true, data: [] }),
  staleTime: Number.POSITIVE_INFINITY,
});

type Tab = "manage" | "backup" | "restore";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/databases"
)({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab:
      search.tab === "manage" ||
      search.tab === "backup" ||
      search.tab === "restore"
        ? search.tab
        : undefined,
  }),
  // Any project role may open the page (the Manage tab lists databases on
  // project:read); Backup (the list) and Restore only render for roles that may
  // use them.
  loader: async ({ context: { queryClient, environmentId, role } }) => {
    // The DB/backup lists are synchronous SSH probes to the remote DB host;
    // they stream behind Suspense so the tab shell paints instantly instead
    // of blocking the page on remote latency. Start them, don't await.
    void queryClient.prefetchQuery(getDatabaseListQuery(environmentId));
    if (
      canAnyProject(role, [{ database: ["backup"] }, { database: ["restore"] }])
    ) {
      void queryClient.prefetchQuery(getBackupListQuery(environmentId));
    }
    void queryClient.prefetchQuery(listEnvironmentsQuery());
    await loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId));
  },
  pendingComponent: DatabasesPending,
  component: DatabasesPage,
});

function DatabasesPage() {
  const { tab } = Route.useSearch();
  const { environmentId, role } = Route.useRouteContext();
  const t = useTranslations("databases");
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const canBackup = canProject(role, { database: ["backup"] });
  const canRestore = canProject(role, { database: ["restore"] });
  const canListBackups = canBackup || canRestore;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  const allowedTabs = [
    ...(canListBackups ? (["backup"] as const) : []),
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
          <Suspense fallback={<DatabasesTabsSkeleton />}>
            <DatabasesContent
              environment={environment}
              defaultTab={defaultTab}
              canBackup={canBackup}
              canRestore={canRestore}
              canListBackups={canListBackups}
            />
          </Suspense>
        </CardContent>
      </Card>
    </>
  );
}

// Everything that awaits a remote SSH probe lives here so the page shell above
// can render before any of it resolves.
function DatabasesContent({
  environment,
  defaultTab,
  canBackup,
  canRestore,
  canListBackups,
}: {
  environment: EnvironmentWithServers;
  defaultTab: Tab;
  canBackup: boolean;
  canRestore: boolean;
  canListBackups: boolean;
}) {
  // Best-effort enumeration; both lists degrade gracefully so a single failing
  // probe never blocks the page from rendering the other tabs. `allProjects`
  // feeds the restore tab's "source environment" picker (filtered client-side
  // to ones sharing this environment's DB location).
  const dbResult = useSuspenseQuery(getDatabaseListQuery(environment.id)).data;
  // getBackupList needs database:backup or database:restore and fails without.
  const backupResult = useSuspenseQuery(
    canListBackups ? getBackupListQuery(environment.id) : NO_BACKUPS
  ).data;
  const allProjects = useSuspenseQuery(listEnvironmentsQuery()).data;
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
