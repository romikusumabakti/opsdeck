import { createFileRoute } from "@tanstack/react-router";
import { HardDrive } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SECTION_PERMS } from "@/lib/nav-path";
import { requireRole } from "@/web/project-guard";
import { StorageForm } from "./-components/env/storage/storage-form";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/new"
)({
  // 404 for callers who cannot edit the environment.
  beforeLoad: ({ context: { role } }) =>
    requireRole(role, SECTION_PERMS.settings),
  component: NewStoragePage,
});

function NewStoragePage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId } = Route.useRouteContext();
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
          <StorageForm
            environmentId={environmentId}
            basePath={`/${projectKey}/${envSlug}/storage`}
          />
        </CardContent>
      </Card>
    </>
  );
}
