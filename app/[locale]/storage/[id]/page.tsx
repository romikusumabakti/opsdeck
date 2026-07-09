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
import { requireAdmin } from "@/lib/auth-session";

export default async function EditStoragePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const connection = await getS3Connection(id);
  if (!connection) notFound();

  const t = await getTranslations("editStorage");

  return (
    <>
      <PageHeader
        title={t("title", { name: connection.name })}
        subtitle={t("description")}
        action={
          <Button
            variant="outline"
            render={<Link href={`/storage/${id}/files`} />}
          >
            <FolderOpen className="size-4" />
            {t("browseFiles")}
          </Button>
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
          <S3ConnectionForm mode={{ type: "edit", connection }} />
        </CardContent>
      </Card>
    </>
  );
}
