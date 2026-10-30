import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { NewProjectButton } from "@/components/new-project-button";
import { PageHeader } from "@/components/page-header";
import { ProjectsEmpty } from "@/components/projects-empty";
import type { SortKey } from "@/components/projects-overview";
import { ProjectsOverview } from "@/components/projects-overview";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { canOrg } from "@/lib/permissions";
import { getEnvironmentsLastOpenedQuery } from "@/web/api/environments";
import { getOpenIssueCountsQuery } from "@/web/api/issues";
import {
  getMyProjectAccessQuery,
  listProjectsWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { getEnvironmentsLastActivityQuery } from "@/web/api/runs";
import { meQuery, useMe } from "@/web/api/session";
import { loaderQuery } from "@/web/query-client";

const SORT_KEYS: SortKey[] = ["recent", "opened", "name_asc", "name_desc"];

export const Route = createFileRoute("/$locale/_app/projects/")({
  validateSearch: (search: Record<string, unknown>): { sort?: SortKey } => ({
    sort: SORT_KEYS.find((key) => key === search.sort),
  }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listProjectsWithEnvironmentsQuery()),
      loaderQuery(queryClient, meQuery()),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
      loaderQuery(queryClient, getEnvironmentsLastActivityQuery()),
      loaderQuery(queryClient, getEnvironmentsLastOpenedQuery()),
      loaderQuery(queryClient, getOpenIssueCountsQuery()),
    ]);
  },
  pendingComponent: ProjectsPending,
  component: ProjectsPage,
});

function ProjectsPage() {
  const t = useTranslations("home");
  const { sort } = Route.useSearch();
  const me = useMe();
  const projects = useSuspenseQuery(listProjectsWithEnvironmentsQuery()).data;
  const access = useSuspenseQuery(getMyProjectAccessQuery()).data;
  const lastActivity = useSuspenseQuery(
    getEnvironmentsLastActivityQuery()
  ).data;
  const lastOpened = useSuspenseQuery(getEnvironmentsLastOpenedQuery()).data;
  const openIssueCounts = useSuspenseQuery(getOpenIssueCountsQuery()).data;

  const orgRole = me?.orgRole ?? "member";
  // The list is every member's; only the create affordances depend on the role.
  const canCreateProject = canOrg(orgRole, { project: ["create"] });

  if (projects.length === 0) {
    return <ProjectsEmpty canCreate={canCreateProject} />;
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        // Only "New project" here: an environment always belongs to a project,
        // so it is created from that project's card (which prefills the parent).
        action={canCreateProject ? <NewProjectButton /> : undefined}
      />
      <ProjectsOverview
        projects={projects}
        openIssueCounts={openIssueCounts}
        lastActivity={lastActivity}
        lastOpened={lastOpened}
        initialSort={sort ?? "recent"}
        projectRoles={access.roles}
        orgRole={orgRole}
      />
    </>
  );
}

// Mirrors ProjectsOverview: search + sort row above a two-column card grid,
// each card a project header over a divided list of its environments.
const CARDS = 4;
const ENVS_PER_CARD = 3;

function ProjectsPending() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-9 w-full sm:ms-auto sm:w-56" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {Array.from({ length: CARDS }, (_, c) => (
            <div
              key={`project-${c}`}
              className="rounded-xl border bg-card overflow-hidden"
            >
              <div className="flex items-start gap-2 px-4 py-3 border-b">
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {/* Project name renders at the base size (24px line box),
                        not `text-sm`, so this bar is taller than the row bars. */}
                    <Skeleton className="h-6 w-44" />
                    <Skeleton className="h-4 w-12 shrink-0" />
                  </div>
                  <Skeleton className="h-4 w-36" />
                </div>
                <Skeleton className="h-8 w-8 shrink-0 sm:w-32" />
              </div>
              <ul className="flex flex-col divide-y">
                {Array.from({ length: ENVS_PER_CARD }, (_, e) => (
                  <li
                    key={`env-${c}-${e}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <Skeleton className="size-3.5 shrink-0 rounded-full" />
                    {/* Bar heights track the line boxes they stand in for —
                        `text-sm` name (20px) over `text-xs` detail (16px), with
                        the row's own `gap-0.5` — so the row does not grow when
                        the real content lands. */}
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <Skeleton className="h-5 w-40" />
                      <Skeleton className="h-4 w-28" />
                    </div>
                    <Skeleton className="h-3 w-16 shrink-0 hidden sm:block" />
                    <Skeleton className="size-4 shrink-0" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
