import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { canOrg, canProject, SETUP_PERMISSIONS } from "@/lib/permissions";
import { listAppsQuery } from "@/web/api/apps";
import { listDeployTargetsQuery } from "@/web/api/deploys";
import { environmentDomainQuery } from "@/web/api/environment-domains";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { getMailpitSettingsQuery } from "@/web/api/mailpit-settings";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { getServersQuery } from "@/web/api/servers";
import { meQuery, useMe } from "@/web/api/session";
import { setupOptionsQuery } from "@/web/api/setup";
import { requireRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import {
  EnvironmentSettingsTabs,
  settingsSearch,
} from "./-components/env/settings/settings-tabs";
import { SettingsPending } from "./-components/env/skeletons";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/settings"
)({
  validateSearch: settingsSearch,
  beforeLoad: ({ context: { role } }) =>
    requireRole(role, { environment: ["update"] }),
  loader: async ({ context: { queryClient, environmentId, role } }) => {
    const me = await queryClient.query(meQuery());
    const environment = await loaderQuery(
      queryClient,
      getEnvironmentByIdQuery(environmentId)
    );
    await Promise.all([
      // Infrastructure bindings (servers, services, credentials) need org
      // server:manage, which lists every server. Without it the server picker
      // offers the servers placement admits (setup options), and the other
      // bindings are shown read-only.
      canOrg(me?.orgRole, { server: ["manage"] })
        ? loaderQuery(queryClient, getServersQuery())
        : environment && canProject(role, SETUP_PERMISSIONS)
          ? loaderQuery(queryClient, setupOptionsQuery(environment.projectId))
          : null,
      loaderQuery(queryClient, listProjectsQuery()),
      loaderQuery(queryClient, listDeployTargetsQuery(environmentId)),
      loaderQuery(queryClient, getMailpitSettingsQuery(environmentId)),
      loaderQuery(queryClient, environmentDomainQuery(environmentId)),
      // The add-target dialog picks the component from the environment's app.
      environment?.appId ? loaderQuery(queryClient, listAppsQuery()) : null,
    ]);
  },
  pendingComponent: SettingsPending,
  component: EnvironmentSettingsPage,
});

function EnvironmentSettingsPage() {
  const { projectKey } = Route.useParams();
  const { tab, add } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { environmentId, role } = Route.useRouteContext();
  const t = useTranslations("environmentSettings");
  const tCommon = useTranslations("common");
  const me = useMe();
  const canManageServers = canOrg(me?.orgRole, { server: ["manage"] });
  // Duplicating opens the New environment page (?from=), for engineers.
  const canSetUp = canProject(role, SETUP_PERMISSIONS);
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const allServers =
    useQuery({ ...getServersQuery(), enabled: canManageServers }).data ?? [];
  const placeable =
    useQuery({
      ...setupOptionsQuery(environment?.projectId ?? ""),
      enabled: !canManageServers && canSetUp && !!environment,
    }).data?.servers ?? [];
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  const targets = useSuspenseQuery(listDeployTargetsQuery(environmentId)).data;
  const mailpit = useSuspenseQuery(getMailpitSettingsQuery(environmentId)).data;
  const domain = useSuspenseQuery(environmentDomainQuery(environmentId)).data;

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <EnvironmentSettingsTabs
        environment={environment}
        targets={targets}
        domain={domain}
        mailpit={mailpit}
        servers={canManageServers ? allServers : placeable}
        projects={projects}
        projectKey={projectKey}
        canManageServers={canManageServers}
        canDuplicate={canSetUp}
        tab={tab ?? "general"}
        onTabChange={(next) =>
          navigate({
            search: next === "general" ? {} : { tab: next },
            replace: true,
          })
        }
        addingTarget={add === "target"}
        onAddingTargetChange={(open) =>
          navigate({
            search: (prev) => ({
              ...prev,
              tab: "source",
              add: open ? "target" : undefined,
            }),
            replace: true,
          })
        }
      />
    </>
  );
}
