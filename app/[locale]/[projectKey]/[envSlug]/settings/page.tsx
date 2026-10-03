import { Copy } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import { getMailpitSettings } from "@/actions/mailpit-settings";
import { listProjects } from "@/actions/project-catalog";
import { getServers, listServerOptions } from "@/actions/servers";
import { EnvironmentForm } from "@/components/environment-form";
import { MailpitSettingsForm } from "@/components/mailpit-settings-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { requireProjectPage } from "@/lib/authz";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { canOrg } from "@/lib/permissions";
import { DeleteEnvironmentCard } from "./delete-environment-card";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const { session, projectId } = await requireProjectPage(
    { environmentId },
    { environment: ["update"] }
  );

  const [environment, servers, projects, mailpit] = await Promise.all([
    getEnvironmentById(environmentId),
    // Full server rows need org-level server:read; without it the picker gets
    // id and name only.
    canOrg(session.user.role, { server: ["read"] })
      ? getServers()
      : listServerOptions(projectId),
    listProjects(),
    getMailpitSettings(environmentId),
  ]);

  const t = await getTranslations("environmentSettings");
  const tCommon = await getTranslations("common");
  const tMailpit = await getTranslations("mailpitSettings");

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Tabs defaultValue="config" className="max-w-2xl w-full">
        <TabsList>
          <TabsTrigger value="config">{t("tabConfig")}</TabsTrigger>
          <TabsTrigger value="danger">{t("tabDanger")}</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("editTitle")}</CardTitle>
              <CardDescription>{t("editDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <EnvironmentForm
                mode={{ type: "edit", environment }}
                servers={servers}
                canManageServers={canOrg(session.user.role, {
                  server: ["manage"],
                })}
                projects={projects}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{tMailpit("title")}</CardTitle>
              <CardDescription>{tMailpit("description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <MailpitSettingsForm
                environmentId={environment.id}
                settings={mailpit}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("duplicateTitle")}</CardTitle>
              <CardDescription>{t("duplicateDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                render={
                  <Link
                    href={`/${projectKey}/environments/new?from=${environment.id}`}
                  />
                }
                variant="outline"
              >
                <Copy className="size-4" />
                {t("duplicateButton")}
              </Button>
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
              <DeleteEnvironmentCard environment={environment} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
