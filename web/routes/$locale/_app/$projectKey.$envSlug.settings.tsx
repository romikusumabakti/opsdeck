import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useTranslations } from "use-intl";
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
import { canCreateEnvironment, canOrg } from "@/lib/permissions";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { getMailpitSettingsQuery } from "@/web/api/mailpit-settings";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { getServersQuery } from "@/web/api/servers";
import { meQuery, useMe } from "@/web/api/session";
import { requireRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { DeleteEnvironmentCard } from "./-components/env/delete-environment-card";
import { SettingsPending } from "./-components/env/skeletons";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/settings"
)({
  beforeLoad: ({ context: { role } }) =>
    requireRole(role, { environment: ["update"] }),
  loader: async ({ context: { queryClient, environmentId } }) => {
    const me = await queryClient.query(meQuery());
    await Promise.all([
      loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId)),
      // Infrastructure bindings (servers, services, credentials) need org
      // server:manage. Without it the form shows them read-only from the
      // stored environment and never fetches the server list.
      canOrg(me?.orgRole, { server: ["manage"] })
        ? loaderQuery(queryClient, getServersQuery())
        : null,
      loaderQuery(queryClient, listProjectsQuery()),
      loaderQuery(queryClient, getMailpitSettingsQuery(environmentId)),
    ]);
  },
  pendingComponent: SettingsPending,
  component: EnvironmentSettingsPage,
});

function EnvironmentSettingsPage() {
  const { projectKey } = Route.useParams();
  const { environmentId, role } = Route.useRouteContext();
  const t = useTranslations("environmentSettings");
  const tCommon = useTranslations("common");
  const tMailpit = useTranslations("mailpitSettings");
  const me = useMe();
  const canManageServers = canOrg(me?.orgRole, { server: ["manage"] });
  // Duplicating opens the new-environment page, which needs both.
  const canDuplicate = canCreateEnvironment(me?.orgRole, role);
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const servers =
    useQuery({ ...getServersQuery(), enabled: canManageServers }).data ?? [];
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  const mailpit = useSuspenseQuery(getMailpitSettingsQuery(environmentId)).data;

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
                canManageServers={canManageServers}
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

          {canDuplicate ? (
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
                  nativeButton={false}
                  variant="outline"
                >
                  <Copy className="size-4" />
                  {t("duplicateButton")}
                </Button>
              </CardContent>
            </Card>
          ) : null}
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
