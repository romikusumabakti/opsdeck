import { FolderOpen, HardDrive } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getS3Connection } from "@/actions/s3-connections";
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
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";

export default async function EditStoragePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const session = await requireOrgPage({ storage: ["read"] });
  // Observers (storage:read) see the connection read-only, and the file
  // browser only with storage:files.
  const canManage = canOrg(session.user.role, { storage: ["manage"] });
  const canBrowse = canOrg(session.user.role, { storage: ["files"] });

  const connection = await getS3Connection(id);
  if (!connection) notFound();

  const t = await getTranslations("editStorage");

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
