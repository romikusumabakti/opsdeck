import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getJiraConnections, getJiraLink } from "@/actions/jira";
import { getProjectByKeyWithEnvironments } from "@/actions/project-catalog";
import { JiraLinkCard } from "@/components/jira-link-card";
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
import { requireProjectPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { DeleteProjectCard } from "./delete-project-card";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string }>;
}) {
  const { locale, projectKey } = await params;
  setRequestLocale(locale);

  // Editing project metadata needs environment:update on this project (same as
  // `editProject`). The key is resolved through the scoped lookup first, so an
  // invisible project 404s before any permission is consulted.
  const project = await getProjectByKeyWithEnvironments(projectKey);
  if (!project) {
    notFound();
  }
  const { session } = await requireProjectPage(
    { projectId: project.id },
    { environment: ["update"] }
  );

  // Deleting a project is an org-level permission, not a project role one.
  const canDelete = canOrg(session.user.role, { project: ["delete"] });
  const t = await getTranslations("projectSettings");
  const [jiraConnections, jiraLink] = await Promise.all([
    // Connections are an org-level integration: a maintainer without that
    // permission just gets no connection to pick from.
    canOrg(session.user.role, { integration: ["manage"] })
      ? getJiraConnections()
      : Promise.resolve([]),
    getJiraLink(project.id),
  ]);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
      />

      <Tabs defaultValue="details" className="max-w-2xl w-full">
        <TabsList>
          <TabsTrigger value="details">{t("tabDetails")}</TabsTrigger>
          <TabsTrigger value="jira">{t("tabJira")}</TabsTrigger>
          {canDelete && (
            <TabsTrigger value="danger">{t("tabDanger")}</TabsTrigger>
          )}
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

        <TabsContent value="jira">
          <Card>
            <CardHeader>
              <CardTitle>{t("jiraTitle")}</CardTitle>
              <CardDescription>{t("jiraDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <JiraLinkCard
                projectId={project.id}
                connections={jiraConnections}
                link={jiraLink}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {canDelete && (
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
        )}
      </Tabs>
    </>
  );
}
