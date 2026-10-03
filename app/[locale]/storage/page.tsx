import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getS3Connections } from "@/actions/s3-connections";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { StorageClient } from "./storage-client";

export default async function StoragePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await requireOrgPage({ storage: ["read"] });
  // storage:read (observers) lists connections; managing them and browsing
  // their files need their own statements, so those controls are hidden too.
  const can = {
    manage: canOrg(session.user.role, { storage: ["manage"] }),
    files: canOrg(session.user.role, { storage: ["files"] }),
  };

  const connections = await getS3Connections();
  const t = await getTranslations("storage");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          can.manage ? (
            <Button render={<Link href="/storage/new" />}>
              <Plus className="size-4" />
              {t("addConnection")}
            </Button>
          ) : undefined
        }
      />
      <StorageClient connections={connections} can={can} />
    </>
  );
}
