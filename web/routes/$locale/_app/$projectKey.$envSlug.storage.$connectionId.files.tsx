import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { FileExplorer } from "@/components/file-explorer";
import { PageHeader } from "@/components/page-header";
import { FileExplorerSkeleton } from "@/components/skeletons/file-explorer-skeleton";
import { SECTION_PERMS } from "@/lib/nav-path";
import { environmentStorageConnectionQuery } from "@/web/api/environment-storage";
import { orNotFound, requireRole } from "@/web/project-guard";

// The existing explorer, scoped to one of the environment's connections (and
// so to its bucket and key prefix). Reading objects takes the variable-read
// right; the server checks it on every explorer request too.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/$connectionId/files"
)({
  beforeLoad: ({ context: { role } }) =>
    requireRole(role, SECTION_PERMS.variables),
  loader: async ({
    params: { connectionId },
    context: { queryClient, environmentId },
  }) => {
    const connection = await orNotFound(
      queryClient.query(
        environmentStorageConnectionQuery(environmentId, connectionId)
      )
    );
    if (connection.isBackupDestination) throw notFound();
  },
  pendingComponent: FileExplorerSkeleton,
  component: StorageFilesPage,
});

function StorageFilesPage() {
  const { connectionId } = Route.useParams();
  const { environmentId } = Route.useRouteContext();
  const t = useTranslations("explorer");
  const connection = useSuspenseQuery(
    environmentStorageConnectionQuery(environmentId, connectionId)
  ).data;

  return (
    <>
      <PageHeader
        title={t("storageFilesTitle", { name: connection.name })}
        subtitle={t("storageFilesSubtitle", { bucket: connection.bucket })}
      />
      <FileExplorer
        source={{ kind: "s3", connectionId }}
        rootLabel={connection.bucket}
      />
    </>
  );
}
