import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getS3Connections } from "@/actions/s3-connections";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/auth-session";
import { StorageClient } from "./storage-client";

export default async function StoragePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const connections = await getS3Connections();
  const t = await getTranslations("storage");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button render={<Link href="/storage/new" />}>
            <Plus className="size-4" />
            {t("addConnection")}
          </Button>
        }
      />
      <StorageClient connections={connections} />
    </>
  );
}
