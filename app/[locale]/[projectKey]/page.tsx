import { formatDistanceToNow } from "date-fns";
import { ChevronRight, Plus } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { listIssues } from "@/actions/issues";
import { listMilestones } from "@/actions/milestones";
import { getProjectByKeyWithEnvironments } from "@/actions/project-catalog";
import { listProjectMembers } from "@/actions/project-members";
import { getEnvironmentsLastActivity } from "@/actions/runs";
import { listAssignableUsers } from "@/actions/users";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import {
  getEffectiveRole,
  getServerSession,
  isAdmin,
} from "@/lib/auth-session";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { roleHasCapability } from "@/lib/roles";
import { IssuesClient } from "./[envSlug]/issues/issues-client";
import { MilestonesClient } from "./milestones-client";
import { ProjectMembersClient } from "./project-members-client";

// Drop the project-name prefix from an environment label under its own project.
function stripPrefix(envName: string, projectName: string): string {
  if (envName.toLowerCase().startsWith(projectName.toLowerCase())) {
    const rest = envName.slice(projectName.length).replace(/^[\s:–—-]+/, "");
    return rest.trim() || envName;
  }
  return envName;
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string }>;
}) {
  const { locale, projectKey } = await params;
  setRequestLocale(locale);

  const [project, session, lastActivity] = await Promise.all([
    getProjectByKeyWithEnvironments(projectKey),
    getServerSession(),
    getEnvironmentsLastActivity(),
  ]);
  if (!project) {
    notFound();
  }
  const admin = session ? isAdmin(session) : false;

  const [issues, users, milestones, t, tOv, tDash, tKinds] = await Promise.all([
    listIssues(project.id),
    listAssignableUsers(),
    listMilestones(project.id),
    getTranslations("home"),
    getTranslations("projectOverview"),
    getTranslations("dashboard"),
    getTranslations("environmentKinds"),
  ]);
  const dateFnsLocale = getDateFnsLocale(locale);

  // Membership is admin-only. Effective role folds in per-project admin, so a
  // project-admin who isn't a global admin still manages members here.
  const canManageMembers = session
    ? roleHasCapability(
        await getEffectiveRole({ projectId: project.id }),
        "admin"
      )
    : false;
  const members = canManageMembers ? await listProjectMembers(project.id) : [];

  const environments = [...project.environments].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={project.client ?? undefined}
        action={
          admin ? (
            <Button render={<Link href={`/${project.key}/environments/new`} />}>
              <Plus className="size-4" />
              {tOv("newEnvironment")}
            </Button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-2 -mt-2">
        <Badge variant="secondary" className="font-mono text-xs">
          {project.key}
        </Badge>
      </div>

      <Tabs defaultValue="environments" className="w-full">
        <TabsList>
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
          {canManageMembers ? (
            <TabsTrigger value="members">
              {tOv("members")}
              <span className="ms-1.5 text-muted-foreground">
                {members.length}
              </span>
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="environments" className="flex flex-col gap-4">
          {environments.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-12 text-center">
              <p className="font-medium">{tOv("noEnvironments")}</p>
              <p className="text-sm text-muted-foreground">
                {tOv("noEnvironmentsDescription")}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                              {stripPrefix(env.name, project.name)}
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

        <TabsContent value="issues">
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

        <TabsContent value="milestones">
          <MilestonesClient
            projectId={project.id}
            initialMilestones={milestones}
          />
        </TabsContent>

        {canManageMembers ? (
          <TabsContent value="members">
            <ProjectMembersClient
              projectId={project.id}
              initialMembers={members}
              assignableUsers={users}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}
