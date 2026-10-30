import { createFileRoute } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { S3ConnectionForm } from "@/components/s3-connection-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/storage/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { storage: ["manage"] });
  },
  component: NewStoragePage,
});

function NewStoragePage() {
  const t = useTranslations("newStorage");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("description")} />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <S3ConnectionForm mode={{ type: "create" }} />
        </CardContent>
      </Card>
    </>
  );
}
