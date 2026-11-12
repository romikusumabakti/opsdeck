import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { EnvironmentHost } from "@/components/nav/environment-host";
import { EnvironmentOwner } from "@/components/nav/environment-owner";
import { EnvironmentUrlButton } from "@/components/nav/environment-url";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, redirect } from "@/i18n/navigation";
import { stripProjectPrefix } from "@/lib/nav-path";
import { canProject, SETUP_PERMISSIONS } from "@/lib/permissions";
import {
  getMyProjectAccessQuery,
  getProjectByKeyWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { getEnvironmentsLastActivityQuery } from "@/web/api/runs";
import { requireProjectRole } from "@/web/project-guard";

// Old `?tab=` links (issues and members lived here as tabs). Milestones no
// longer exist, so `?tab=milestones` is an unknown tab and stays on the Environments page.
const REDIRECT_TABS = ["issues", "members"] as const;
type RedirectTab = (typeof REDIRECT_TABS)[number];
const isRedirectTab = (value: unknown): value is RedirectTab =>
  REDIRECT_TABS.includes(value as RedirectTab);

export const Route = createFileRoute("/$locale/_app/$projectKey/")({
  // `tab` and `status` are only read to redirect old links; `tab=environments`
  // or an unknown tab just stays here.
  validateSearch: (
    search: Record<string, unknown>
  ): { status?: string; tab?: RedirectTab } => ({
    status: typeof search.status === "string" ? search.status : undefined,
    tab: isRedirectTab(search.tab) ? search.tab : undefined,
  }),
  // 404 when the project is unknown or invisible to the caller.
  beforeLoad: async ({
    params: { locale, projectKey },
    search: { status, tab },
    context: { queryClient },
  }) => {
    if (tab === "members") {
      redirect(`/${projectKey}/settings?tab=members`, locale);
    }
    if (tab) {
      const qs =
        tab === "issues" && status
          ? `?status=${encodeURIComponent(status)}`
          : "";
      redirect(`/${projectKey}/${tab}${qs}`, locale);
    }
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
    await requireProjectRole(queryClient, project.id);
  },
  pendingComponent: ProjectPending,
  component: ProjectOverviewPage,
});

function ProjectOverviewPage() {
  const { projectKey } = Route.useParams();
  const t = useTranslations("home");
  const tOv = useTranslations("projectOverview");
  const tDash = useTranslations("dashboard");
  const tKinds = useTranslations("environmentKinds");
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  const lastActivity = useSuspenseQuery(
    getEnvironmentsLastActivityQuery()
  ).data;
  const roles = useSuspenseQuery(getMyProjectAccessQuery()).data.roles;
  if (!project) throw notFound();
  const role = roles[project.id] ?? null;
  // Engineers set environments up on the project's servers (the page
  // offers only the ones they may place on).
  const canCreateEnvironment = canProject(role, SETUP_PERMISSIONS);

  const environments = [...project.environments].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={project.client ?? undefined}
        action={
          canCreateEnvironment ? (
            <Button
              nativeButton={false}
              render={<Link href={`/${project.key}/environments/new`} />}
            >
              <Plus className="size-4" />
              {tOv("newEnvironment")}
            </Button>
          ) : undefined
        }
      />

      <div className="shrink-0 flex items-center gap-2 -mt-2">
        <Badge variant="secondary" className="font-mono text-sm">
          {project.key}
        </Badge>
      </div>

      <div className="flex flex-1 min-h-0 flex-col gap-4">
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
              // The name link stretches over the whole card (after:inset-0),
              // so the card is one click target; the URL button sits above
              // it (z-10) and opens the app instead.
              return (
                <div key={env.id} className="group relative">
                  <Card className="h-full py-0 group-hover:border-primary/50 group-hover:shadow-sm transition-all">
                    <CardContent className="p-4 flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Link
                            href={`/${project.key}/${env.slug}`}
                            className="font-medium truncate after:absolute after:inset-0 after:rounded-xl focus:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                          >
                            {stripProjectPrefix(env.name, project.name)}
                          </Link>
                          <EnvironmentUrlButton
                            url={env.url}
                            className="relative z-10"
                          />
                          <EnvironmentHost
                            url={env.url}
                            className="max-w-[40%]"
                          />
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
                      {env.dbType ? (
                        <div className="flex items-center gap-2 text-sm min-w-0">
                          <Badge
                            variant="secondary"
                            className="text-xs shrink-0"
                          >
                            {tDash(`dbTypes.${env.dbType}`)}
                          </Badge>
                          <code className="font-mono text-sm text-muted-foreground truncate">
                            {env.dbName}
                          </code>
                        </div>
                      ) : null}
                      <EnvironmentOwner owner={env.owner} />
                      <span className="text-xs text-muted-foreground">
                        {activity ? (
                          <RelativeTime date={activity.runAt} />
                        ) : (
                          t("neverActive")
                        )}
                      </span>
                    </CardContent>
                  </Card>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// No ancestor boundary covers this route. Shapes the page: header, key
// badge, card grid.
function ProjectPending() {
  return (
    <>
      <PageHeaderSkeleton />
      <Skeleton className="h-6 w-16 -mt-2" />
      <div className="flex flex-1 min-h-0 flex-col gap-4">
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
