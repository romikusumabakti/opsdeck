import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { FolderOpen, HardDrive } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { S3ConnectionForm } from "@/components/s3-connection-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { getS3ConnectionQuery } from "@/web/api/s3-connections";
import { useMe } from "@/web/api/session";
import { orNotFound, requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/storage/$id/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { storage: ["read"] }),
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const connection = await orNotFound(
      queryClient.query(getS3ConnectionQuery(id))
    );
    if (!connection) throw notFound();
  },
  component: EditStoragePage,
});

function EditStoragePage() {
  const { id } = Route.useParams();
  const t = useTranslations("editStorage");
  const me = useMe();
  // Observers (storage:read) see the connection read-only, and the file
  // browser only with storage:files.
  const canManage = canOrg(me?.orgRole, { storage: ["manage"] });
  const canBrowse = canOrg(me?.orgRole, { storage: ["files"] });
  const connection = useSuspenseQuery(getS3ConnectionQuery(id)).data;
  if (!connection) return null;

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
              render={<Link href={`/storage/${id}/files`} />}
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
          <S3ConnectionForm
            mode={{ type: "edit", connection }}
            readOnly={!canManage}
          />
        </CardContent>
      </Card>
    </>
  );
}
