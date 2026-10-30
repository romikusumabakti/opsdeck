import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { ChevronRight, Plus, Settings } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { stripProjectPrefix } from "@/lib/nav-path";
import {
  canCreateEnvironment as canCreateEnvironmentIn,
  canProject,
} from "@/lib/permissions";
import { listIssuesQuery } from "@/web/api/issues";
import { listMilestonesQuery } from "@/web/api/milestones";
import {
  getMyProjectAccessQuery,
  getProjectByKeyWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import {
  listMemberCandidatesQuery,
  listOrgWideAccessQuery,
  listProjectMembersQuery,
} from "@/web/api/project-members";
import { getEnvironmentsLastActivityQuery } from "@/web/api/runs";
import { useMe } from "@/web/api/session";
import { listAssignableUsersQuery } from "@/web/api/users";
import { requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { IssuesClient } from "./-components/issues-client";
import { MilestonesClient } from "./-components/project/milestones-client";
import { ProjectMembersClient } from "./-components/project/project-members-client";

export const Route = createFileRoute("/$locale/_app/$projectKey/")({
  // 404 when the project is unknown or invisible to the caller.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(queryClient, project.id);
  },
  loader: async ({ params: { projectKey }, context: { queryClient } }) => {
    const [project] = await Promise.all([
      queryClient.query(getProjectByKeyWithEnvironmentsQuery(projectKey)),
      queryClient.query(getEnvironmentsLastActivityQuery()),
    ]);
    if (!project) throw notFound();
    const role = await requireProjectRole(queryClient, project.id);
    await Promise.all([
      loaderQuery(queryClient, listIssuesQuery(project.id)),
      loaderQuery(queryClient, listAssignableUsersQuery(project.id)),
      loaderQuery(queryClient, listMilestonesQuery(project.id)),
      // Membership management follows the project role.
      ...(canProject(role, { member: ["manage"] })
        ? [
            loaderQuery(queryClient, listProjectMembersQuery(project.id)),
            loaderQuery(queryClient, listMemberCandidatesQuery(project.id)),
            loaderQuery(queryClient, listOrgWideAccessQuery(project.id)),
          ]
        : []),
    ]);
  },
  pendingComponent: ProjectPending,
  component: ProjectOverviewPage,
});

function ProjectOverviewPage() {
  const { locale, projectKey } = Route.useParams();
  const t = useTranslations("home");
  const tOv = useTranslations("projectOverview");
  const tDash = useTranslations("dashboard");
  const tKinds = useTranslations("environmentKinds");
  const me = useMe();
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  const lastActivity = useSuspenseQuery(
    getEnvironmentsLastActivityQuery()
  ).data;
  const roles = useSuspenseQuery(getMyProjectAccessQuery()).data.roles;
  if (!project) throw notFound();
  const role = roles[project.id] ?? null;
  const canUpdateEnvironment = canProject(role, { environment: ["update"] });
  const canCreateEnvironment = canCreateEnvironmentIn(me?.orgRole, role);
  const canManageMembers = canProject(role, { member: ["manage"] });

  const issues = useSuspenseQuery(listIssuesQuery(project.id)).data;
  const users = useSuspenseQuery(listAssignableUsersQuery(project.id)).data;
  const milestones = useSuspenseQuery(listMilestonesQuery(project.id)).data;
  const dateFnsLocale = getDateFnsLocale(locale);

  const environments = [...project.environments].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={project.client ?? undefined}
        action={
          canUpdateEnvironment || canCreateEnvironment ? (
            <div className="flex items-center gap-2">
              {canUpdateEnvironment && (
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link href={`/${project.key}/settings`} />}
                >
                  <Settings className="size-4" />
                  <span className="hidden sm:inline">{tOv("editProject")}</span>
                </Button>
              )}
              {canCreateEnvironment && (
                <Button
                  nativeButton={false}
                  render={<Link href={`/${project.key}/environments/new`} />}
                >
                  <Plus className="size-4" />
                  {tOv("newEnvironment")}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="shrink-0 flex items-center gap-2 -mt-2">
        <Badge variant="secondary" className="font-mono text-xs">
          {project.key}
        </Badge>
      </div>

      {/* The tab strip stays put and each panel scrolls inside the page shell,
          so switching tabs never moves the strip out from under the cursor and
          a long list can't push the pager off-screen. */}
      <Tabs
        defaultValue="environments"
        // `gap-4`, matching the other full-height tab layouts (users,
        // databases) — the primitive's `gap-2` default sits a panel too close
        // under its own tab strip.
        className="flex w-full flex-1 min-h-0 flex-col gap-4"
      >
        <TabsList className="shrink-0">
          <TabsTrigger value="environments">
            {tOv("environments")}
            <span className="ms-1.5 text-muted-foreground">
              {environments.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="issues">
            {tOv("issues")}
            <span className="ms-1.5 text-muted-foreground">
              {issues.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="milestones">
            {tOv("milestones")}
            <span className="ms-1.5 text-muted-foreground">
              {milestones.length}
            </span>
          </TabsTrigger>
          {canManageMembers ? <MembersTab projectId={project.id} /> : null}
        </TabsList>

        <TabsContent
          value="environments"
          className="flex flex-1 min-h-0 flex-col gap-4"
        >
          {environments.length === 0 ? (
            <div className="shrink-0 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-12 text-center">
              <p className="font-medium">{tOv("noEnvironments")}</p>
              <p className="text-sm text-muted-foreground">
                {tOv("noEnvironmentsDescription")}
              </p>
            </div>
          ) : (
            // The card grid is the scroll box — there is nothing above it in
            // this panel to keep pinned. `content-start` because a grid that is
            // taller than its rows stretches them by default, which would blow
            // up the cards to fill the panel when there are only a few.
            <div className="grid content-start flex-1 min-h-0 grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {environments.map((env) => {
                const activity = lastActivity[env.id] ?? null;
                return (
                  <Link
                    key={env.id}
                    href={`/${project.key}/${env.slug}`}
                    className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
                  >
                    <Card className="h-full py-0 hover:border-primary/50 hover:shadow-sm transition-all">
                      <CardContent className="p-4 flex flex-col gap-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-medium truncate">
                              {stripProjectPrefix(env.name, project.name)}
                            </span>
                            {env.kind ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] uppercase shrink-0"
                              >
                                {tKinds(env.kind)}
                              </Badge>
                            ) : null}
                          </div>
                          <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
                        </div>
                        <div className="flex items-center gap-2 text-sm min-w-0">
                          <Badge
                            variant="secondary"
                            className="text-xs shrink-0"
                          >
                            {tDash(`dbTypes.${env.dbType}`)}
                          </Badge>
                          <code className="font-mono text-xs text-muted-foreground truncate">
                            {env.dbName}
                          </code>
                        </div>
                        {env.owner ? (
                          <span className="text-xs text-muted-foreground truncate">
                            {t("ownedBy", { owner: env.owner })}
                          </span>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {activity
                            ? formatDistanceToNow(new Date(activity.runAt), {
                                addSuffix: true,
                                locale: dateFnsLocale,
                              })
                            : t("neverActive")}
                        </span>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* The issues list bounds and scrolls itself (sticky header, pager
            pinned below), so this panel only has to hand it the height. */}
        <TabsContent value="issues" className="flex flex-1 min-h-0 flex-col">
          <IssuesClient
            projectId={project.id}
            projectKey={project.key}
            currentEnvironmentId=""
            environments={environments.map((e) => ({ id: e.id, name: e.name }))}
            users={users}
            milestones={milestones.map((m) => ({ id: m.id, name: m.name }))}
            initialIssues={issues}
          />
        </TabsContent>

        <TabsContent
          value="milestones"
          className="flex flex-1 min-h-0 flex-col"
        >
          <MilestonesClient
            projectId={project.id}
            initialMilestones={milestones}
          />
        </TabsContent>

        {canManageMembers ? (
          <TabsContent value="members" className="flex flex-1 min-h-0 flex-col">
            <MembersPanel projectId={project.id} projectName={project.name} />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

// The members tab and panel read their own queries: the lists are only loaded
// (and only exist) for a maintainer, so they cannot be hooks of the page.
function MembersTab({ projectId }: { projectId: string }) {
  const tOv = useTranslations("projectOverview");
  const members = useSuspenseQuery(listProjectMembersQuery(projectId)).data;
  return (
    <TabsTrigger value="members">
      {tOv("members")}
      <span className="ms-1.5 text-muted-foreground">{members.length}</span>
    </TabsTrigger>
  );
}

function MembersPanel({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const members = useSuspenseQuery(listProjectMembersQuery(projectId)).data;
  const memberCandidates = useSuspenseQuery(
    listMemberCandidatesQuery(projectId)
  ).data;
  const orgWideAccess = useSuspenseQuery(
    listOrgWideAccessQuery(projectId)
  ).data;
  return (
    <ProjectMembersClient
      projectId={projectId}
      projectName={projectName}
      initialMembers={members}
      memberCandidates={memberCandidates}
      orgWideAccess={orgWideAccess}
    />
  );
}

// No ancestor boundary covers this route. Shapes the default tab
// (Environments): key badge, tab strip, card grid.
function ProjectPending() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="h-6 w-16 -mt-2" />
      <div className="flex flex-1 min-h-0 flex-col gap-4">
        <Skeleton className="h-9 w-80 shrink-0 rounded-lg" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={`env-${i}`}
              className="flex flex-col gap-2.5 rounded-lg border p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="size-4 shrink-0" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-4 w-28" />
              </div>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
