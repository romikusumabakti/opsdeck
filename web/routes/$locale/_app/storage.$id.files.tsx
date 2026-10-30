import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { FileExplorer } from "@/components/file-explorer";
import { PageHeader } from "@/components/page-header";
import { FileExplorerSkeleton } from "@/components/skeletons/file-explorer-skeleton";
import { getS3ConnectionQuery } from "@/web/api/s3-connections";
import { orNotFound, requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/storage/$id/files")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { storage: ["files"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const connection = await orNotFound(
      queryClient.query(getS3ConnectionQuery(id))
    );
    if (!connection) throw notFound();
  },
  pendingComponent: FileExplorerSkeleton,
  component: StorageFilesPage,
});

function StorageFilesPage() {
  const { id } = Route.useParams();
  const t = useTranslations("explorer");
  const connection = useSuspenseQuery(getS3ConnectionQuery(id)).data;
  if (!connection) return null;

  return (
    <>
      <PageHeader
        title={t("storageFilesTitle", { name: connection.name })}
        subtitle={t("storageFilesSubtitle", { bucket: connection.bucket })}
      />
      <FileExplorer
        source={{ kind: "s3", connectionId: id }}
        rootLabel={connection.bucket}
      />
    </>
  );
}
