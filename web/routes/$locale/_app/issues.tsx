import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { GlobalIssuesClient } from "@/components/global-issues-client";
import { PageHeader } from "@/components/page-header";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { BOARD_LIMIT, parseIssueParams } from "@/lib/issue-query";
import { listAllIssuesQuery } from "@/web/api/issues";
import { listLabelsQuery } from "@/web/api/labels";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { listSavedViewsQuery } from "@/web/api/saved-views";
import { meQuery } from "@/web/api/session";
import { listAssignableUsersAcrossProjectsQuery } from "@/web/api/users";
import type { SearchRecord } from "@/web/search-params";

// Filters, sort and page live in the query string (see lib/issue-query.ts), so
// every key passes through untouched: saved views and shared links keep the
// exact shape they have always had.
type IssuesSearch = SearchRecord;

function issuesQueryFor(search: IssuesSearch, meId: string) {
  const { filters, sort, desc, pageIndex, pageSize } = parseIssueParams(search);
  // The board draws every matching issue in status columns, so it can't page —
  // it takes a capped slice instead and says so when the cap bites.
  const isBoard = filters.view === "board";
  return listAllIssuesQuery({
    q: filters.q,
    status: filters.status,
    projectId: filters.project,
    labelId: filters.label,
    priority: filters.priority,
    assigneeId: filters.mine === "1" ? meId : filters.assignee,
    sort,
    desc,
    offset: isBoard ? 0 : pageIndex * pageSize,
    limit: isBoard ? BOARD_LIMIT : pageSize,
  });
}

export const Route = createFileRoute("/$locale/_app/issues")({
  validateSearch: (search: Record<string, unknown>): IssuesSearch => {
    const out: IssuesSearch = {};
    for (const [key, value] of Object.entries(search)) {
      if (typeof value === "string") out[key] = value;
      else if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        out[key] = value as string[];
      }
    }
    return out;
  },
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ deps: { search }, context: { queryClient } }) => {
    const me = await queryClient.query(meQuery());
    if (!me) return;
    await Promise.all([
      queryClient.query(issuesQueryFor(search, me.user.id)),
      queryClient.query(listAssignableUsersAcrossProjectsQuery()),
      queryClient.query(listLabelsQuery()),
      queryClient.query(listSavedViewsQuery()),
      // From the project table, not from the loaded issues: a project with no
      // issue on the current page must still be selectable in the filter.
      queryClient.query(listProjectsQuery()),
    ]);
  },
  pendingComponent: IssuesPending,
  component: GlobalIssuesPage,
});

function IssuesPending() {
  return (
    <>
      <PageHeaderSkeleton />
      <DataTableSkeleton fillHeight columns={7} />
    </>
  );
}

function GlobalIssuesPage() {
  const t = useTranslations("issues");
  const search = Route.useSearch();
  const me = useSuspenseQuery(meQuery()).data;
  const { filters, pageSize } = parseIssueParams(search);
  const page = useSuspenseQuery(issuesQueryFor(search, me?.user.id ?? "")).data;
  const users = useSuspenseQuery(listAssignableUsersAcrossProjectsQuery()).data;
  const allLabels = useSuspenseQuery(listLabelsQuery()).data;
  const savedViews = useSuspenseQuery(listSavedViewsQuery()).data;
  const projects = useSuspenseQuery(listProjectsQuery()).data;

  return (
    <>
      <PageHeader title={t("globalTitle")} subtitle={t("globalSubtitle")} />
      <GlobalIssuesClient
        issues={page.rows}
        total={page.total}
        users={users}
        allLabels={allLabels}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        savedViews={savedViews}
        filters={filters}
        pageSize={pageSize}
      />
    </>
  );
}
