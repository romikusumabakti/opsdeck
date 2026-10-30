import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { FileExplorer } from "@/components/file-explorer";
import { PageHeader } from "@/components/page-header";
import { FileExplorerSkeleton } from "@/components/skeletons/file-explorer-skeleton";
import { getServerByIdQuery } from "@/web/api/servers";
import { orNotFound, requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/servers/$id/files")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { server: ["files"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const server = await orNotFound(queryClient.query(getServerByIdQuery(id)));
    if (!server) throw notFound();
  },
  pendingComponent: FileExplorerSkeleton,
  component: ServerFilesPage,
});

function ServerFilesPage() {
  const { id } = Route.useParams();
  const t = useTranslations("explorer");
  const server = useSuspenseQuery(getServerByIdQuery(id)).data;
  if (!server) return null;

  return (
    <>
      <PageHeader
        title={t("serverFilesTitle", { name: server.name })}
        subtitle={t("serverFilesSubtitle", { root: server.sftpRoot })}
      />
      <FileExplorer
        source={{ kind: "sftp", serverId: id }}
        rootLabel={server.sftpRoot}
      />
    </>
  );
}
