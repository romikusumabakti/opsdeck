import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectByKeyWithEnvironments } from "@/actions/project-catalog";
import { PageHeader } from "@/components/page-header";
import { ProjectForm } from "@/components/project-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireAdmin } from "@/lib/auth-session";
import { DeleteProjectCard } from "./delete-project-card";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string }>;
}) {
  const { locale, projectKey } = await params;
  setRequestLocale(locale);

  // Editing project metadata and deleting a project are both admin-only, same
  // as the `editProject` / `removeProject` actions themselves.
  await requireAdmin();

  const project = await getProjectByKeyWithEnvironments(projectKey);
  if (!project) {
    notFound();
  }

  const t = await getTranslations("projectSettings");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
      />

      <Tabs defaultValue="details" className="max-w-2xl w-full">
        <TabsList>
          <TabsTrigger value="details">{t("tabDetails")}</TabsTrigger>
          <TabsTrigger value="danger">{t("tabDanger")}</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <Card>
            <CardHeader>
              <CardTitle>{t("editTitle")}</CardTitle>
              <CardDescription>{t("editDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ProjectForm mode={{ type: "edit", project }} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger">
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="text-destructive">
                {t("dangerZoneTitle")}
              </CardTitle>
              <CardDescription>{t("dangerZoneDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteProjectCard
                project={project}
                environmentCount={project.environments.length}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
