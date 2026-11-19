import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { FolderOpen, HardDrive } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { SECTION_PERMS } from "@/lib/nav-path";
import { canProject } from "@/lib/permissions";
import { environmentStorageConnectionQuery } from "@/web/api/environment-storage";
import { orNotFound } from "@/web/project-guard";
import { StorageForm } from "./-components/env/storage/storage-form";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/$connectionId/"
)({
  loader: async ({
    params: { connectionId },
    context: { queryClient, environmentId },
  }) => {
    const connection = await orNotFound(
      queryClient.query(
        environmentStorageConnectionQuery(environmentId, connectionId)
      )
    );
    // The instance backup bucket is Admin › Instance's, not the environment's.
    if (connection.isBackupDestination) throw notFound();
  },
  component: EditStoragePage,
});

function EditStoragePage() {
  const { projectKey, envSlug, connectionId } = Route.useParams();
  const { environmentId, role } = Route.useRouteContext();
  const t = useTranslations("editStorage");
  const connection = useSuspenseQuery(
    environmentStorageConnectionQuery(environmentId, connectionId)
  ).data;
  const basePath = `/${projectKey}/${envSlug}/storage`;
  // Viewers see the connection read-only; browsing needs variable read.
  const canManage = canProject(role, SECTION_PERMS.settings);
  const canBrowse = canProject(role, SECTION_PERMS.variables);

  return (
    <>
      <PageHeader
        title={
          canManage ? t("title", { name: connection.name }) : connection.name
        }
        subtitle={t("description")}
        action={
          canBrowse ? (
            <Button
              nativeButton={false}
              variant="outline"
              render={<Link href={`${basePath}/${connectionId}/files`} />}
            >
              <FolderOpen className="size-4" />
              {t("browseFiles")}
            </Button>
          ) : undefined
        }
      />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <StorageForm
            key={connection.updatedAt}
            environmentId={environmentId}
            basePath={basePath}
            connection={connection}
            readOnly={!canManage}
          />
        </CardContent>
      </Card>
    </>
  );
}
