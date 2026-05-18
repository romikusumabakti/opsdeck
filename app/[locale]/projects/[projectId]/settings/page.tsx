import { Copy } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { getServers } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
import { ProjectForm } from "@/components/project-form";
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
import { DeleteProjectCard } from "./delete-project-card";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const [project, servers] = await Promise.all([
    getProjectById(projectId),
    getServers(),
  ]);

  const t = await getTranslations("projectSettings");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="flex flex-col gap-6 max-w-2xl w-full">
        <Card>
          <CardHeader>
            <CardTitle>{t("editTitle")}</CardTitle>
            <CardDescription>{t("editDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProjectForm mode={{ type: "edit", project }} servers={servers} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("duplicateTitle")}</CardTitle>
            <CardDescription>{t("duplicateDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/projects/new?from=${project.id}`}>
                <Copy className="size-4" />
                {t("duplicateButton")}
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">
              {t("dangerZoneTitle")}
            </CardTitle>
            <CardDescription>{t("dangerZoneDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteProjectCard project={project} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
