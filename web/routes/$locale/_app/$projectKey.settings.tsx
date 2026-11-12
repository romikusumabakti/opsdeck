import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { JiraLinkCard } from "@/components/jira-link-card";
import { PageHeader } from "@/components/page-header";
import { ProjectForm } from "@/components/project-form";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { canOrg, canOrgAccess, canProject } from "@/lib/permissions";
import { getJiraConnectionsQuery, getJiraLinkQuery } from "@/web/api/jira";
import {
  getMyProjectAccessQuery,
  getProjectByKeyWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import {
  listMemberCandidatesQuery,
  listProjectMembersQuery,
} from "@/web/api/project-members";
import { getServersQuery } from "@/web/api/servers";
import { meQuery, useCanOrg, useMe } from "@/web/api/session";
import { projectRoleOf, requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { DeleteProjectCard } from "./-components/project/delete-project-card";
import { ProjectMembersTab } from "./-components/project/project-members-client";
import {
  projectSettingsSearch,
  visibleSettingsTab,
} from "./-components/project/project-settings-search";

export const Route = createFileRoute("/$locale/_app/$projectKey/settings")({
  validateSearch: projectSettingsSearch,
  // Editing project metadata needs environment:update on this project (same as
  // `editProject`). The key is resolved through the scoped lookup first, so an
  // invisible project 404s before any permission is consulted.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(queryClient, project.id, {
      environment: ["update"],
    });
  },
  loader: async ({ params: { projectKey }, context: { queryClient } }) => {
    const [project, me] = await Promise.all([
      queryClient.query(getProjectByKeyWithEnvironmentsQuery(projectKey)),
      queryClient.query(meQuery()),
    ]);
    if (!project) throw notFound();
    const role = await projectRoleOf(queryClient, project.id);
    await Promise.all([
      // The Members tab is only offered to callers who can manage members.
      canProject(role, { member: ["manage"] })
        ? Promise.all([
            loaderQuery(queryClient, listProjectMembersQuery(project.id)),
            loaderQuery(queryClient, listMemberCandidatesQuery(project.id)),
          ])
        : null,
      // Connections are an org-level integration: an engineer without that
      // permission just gets no connection to pick from.
      canOrg(me?.orgRole, { integration: ["manage"] })
        ? loaderQuery(queryClient, getJiraConnectionsQuery())
        : null,
      // The Default server field names the servers; listing them needs
      // server:read, changing the default server:manage.
      canOrgAccess(me?.orgRole, { server: ["read"] })
        ? loaderQuery(queryClient, getServersQuery())
        : null,
      loaderQuery(queryClient, getJiraLinkQuery(project.id)),
    ]);
  },
  pendingComponent: SettingsPending,
  component: ProjectSettingsPage,
});

function ProjectSettingsPage() {
  const { projectKey } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const t = useTranslations("projectSettings");
  const me = useMe();
  const canAccess = useCanOrg();
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  if (!project) throw notFound();
  // Deleting a project is an org-level permission, not a project role one.
  const canDelete = canOrg(me?.orgRole, { project: ["delete"] });
  const roles = useSuspenseQuery(getMyProjectAccessQuery()).data.roles;
  const canManageMembers = canProject(roles[project.id] ?? null, {
    member: ["manage"],
  });
  const jiraLink = useSuspenseQuery(getJiraLinkQuery(project.id)).data;
  const jiraConnections =
    useQuery({
      ...getJiraConnectionsQuery(),
      enabled: canOrg(me?.orgRole, { integration: ["manage"] }),
    }).data ?? [];
  const servers =
    useQuery({
      ...getServersQuery(),
      enabled: canAccess({ server: ["read"] }),
      select: (rows) => rows.map(({ id, name }) => ({ id, name })),
    }).data ?? [];
  const canChangeDefaultServer = canOrg(me?.orgRole, { server: ["manage"] });

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
      />

      <Tabs
        value={visibleSettingsTab(tab, {
          members: canManageMembers,
          danger: canDelete,
        })}
        onValueChange={(next) =>
          navigate({
            search: next === "details" ? {} : { tab: next },
            replace: true,
          })
        }
        className="max-w-2xl w-full"
      >
        <TabsList>
          <TabsTrigger value="details">{t("tabDetails")}</TabsTrigger>
          <TabsTrigger value="jira">{t("tabJira")}</TabsTrigger>
          {canManageMembers && (
            <TabsTrigger value="members">{t("tabMembers")}</TabsTrigger>
          )}
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
              <ProjectForm
                mode={{ type: "edit", project }}
                defaultServer={{ servers, canChange: canChangeDefaultServer }}
              />
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

        {canManageMembers && (
          <TabsContent value="members">
            <Card>
              <CardHeader>
                <CardTitle>{t("membersTitle")}</CardTitle>
                <CardDescription>{t("membersDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ProjectMembersTab
                  projectId={project.id}
                  projectName={project.name}
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}

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

// The parent `[projectKey]/loading.tsx` shapes the overview's tabbed card grid,
// which is nothing like this page — override it with the settings shape.
function SettingsPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <div className="flex flex-col gap-6 max-w-2xl w-full">
        {/* TabsList */}
        <Skeleton className="h-9 w-56 rounded-lg" />

        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-28" />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
