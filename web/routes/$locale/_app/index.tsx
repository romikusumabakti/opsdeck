import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { defaultIssueTarget } from "@/lib/home/layout";
import {
  getAttentionGroupsQuery,
  getHomeAccessQuery,
  listIssueProjectsQuery,
  listMyOpenIssuesQuery,
  listRecentEnvironmentsQuery,
} from "@/web/api/home";
import { HomeHeader } from "./-components/home/home-header";
import { HomeIssueDialogProvider } from "./-components/home/home-issue-dialog";
import { MainColumn } from "./-components/home/main-column";
import { NewIssueButton } from "./-components/home/new-issue-button";
import { RecentEnvsSection } from "./-components/home/recent-envs-section";
import { RunningRail } from "./-components/home/running-rail";
import { MainColumnSkeleton, RailSkeleton } from "./-components/home/skeletons";

export const Route = createFileRoute("/$locale/_app/")({
  // The page waits for the two queries its header and rail are made of. A
  // failure of either is not a failed page: New issue is disabled, or the
  // rail shows its error row (the component reads the failed query as such).
  // The main column is not awaited: it streams in behind its own skeleton, so
  // its queries are only started here.
  loader: async ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(getAttentionGroupsQuery());
    void queryClient.prefetchQuery(listMyOpenIssuesQuery());
    void queryClient.prefetchQuery(getHomeAccessQuery());
    const results = await Promise.allSettled([
      queryClient.query(listIssueProjectsQuery()),
      queryClient.query(listRecentEnvironmentsQuery()),
    ]);
    for (const r of results) {
      if (r.status === "rejected")
        console.error("Home query failed:", r.reason);
    }
  },
  pendingComponent: HomePending,
  component: HomePage,
});

// Main column: what needs the user (failures, their issues) — streamed, and
// ordered by what it contains. Rail: context (live runs, recent environments).
function HomePage() {
  const issueProjects = useQuery({
    ...listIssueProjectsQuery(),
    retryOnMount: false,
  }).data;
  const recent =
    useQuery({ ...listRecentEnvironmentsQuery(), retryOnMount: false }).data ??
    null;

  const projects = issueProjects ?? [];
  const target = defaultIssueTarget(
    recent ?? [],
    new Set(projects.map((p) => p.id))
  );
  return (
    <HomeIssueDialogProvider projects={projects} defaultTarget={target}>
      <HomeHeader action={<NewIssueButton />} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <MainColumn />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <RunningRail />
          <RecentEnvsSection environments={recent} />
        </aside>
      </div>
    </HomeIssueDialogProvider>
  );
}

function HomePending() {
  return (
    <>
      <PageHeaderSkeleton withAction withSubtitle={false} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <MainColumnSkeleton />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <RailSkeleton />
        </div>
      </div>
    </>
  );
}
