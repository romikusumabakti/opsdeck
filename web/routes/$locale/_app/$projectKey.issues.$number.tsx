import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { canProject } from "@/lib/permissions";
import { listIssueAttachmentsQuery } from "@/web/api/issue-attachments";
import { getIssueDetailQuery, listIssuesQuery } from "@/web/api/issues";
import { getJiraLinkQuery } from "@/web/api/jira";
import { listLabelsQuery } from "@/web/api/labels";
import {
  getMyProjectAccessQuery,
  getProjectWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { listIssueTestRunsQuery } from "@/web/api/test-runs";
import { listAssignableUsersQuery } from "@/web/api/users";
import { loaderQuery } from "@/web/query-client";
import { IssueDetailClient } from "./-components/project/issue-detail-client";

function issueNumber(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/issues/$number"
)({
  // The number is a positive integer, or this is not an issue URL.
  beforeLoad: ({ params: { number } }) => {
    if (!issueNumber(number)) throw notFound();
  },
  loader: async ({
    params: { projectKey, number },
    context: { queryClient },
  }) => {
    const issue = await queryClient.query(
      getIssueDetailQuery(projectKey, issueNumber(number) ?? 0)
    );
    if (!issue) throw notFound();
    await Promise.all([
      loaderQuery(
        queryClient,
        getProjectWithEnvironmentsQuery(issue.project.id)
      ),
      loaderQuery(queryClient, listAssignableUsersQuery(issue.project.id)),
      loaderQuery(queryClient, listLabelsQuery()),
      loaderQuery(queryClient, listIssuesQuery(issue.project.id)),
      loaderQuery(queryClient, listIssueAttachmentsQuery(issue.id)),
      loaderQuery(queryClient, listIssueTestRunsQuery(issue.id)),
      loaderQuery(queryClient, getJiraLinkQuery(issue.project.id)),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
    ]);
  },
  pendingComponent: IssuePending,
  component: IssueDetailPage,
});

function IssueDetailPage() {
  const { projectKey, number } = Route.useParams();
  const t = useTranslations("issueDetail");
  const tIssues = useTranslations("issues");
  const queryClient = useQueryClient();
  const detailQuery = getIssueDetailQuery(projectKey, issueNumber(number) ?? 0);
  const issue = useSuspenseQuery(detailQuery).data;
  if (!issue) throw notFound();
  const project = useSuspenseQuery(
    getProjectWithEnvironmentsQuery(issue.project.id)
  ).data;
  const users = useSuspenseQuery(
    listAssignableUsersQuery(issue.project.id)
  ).data;
  const allLabels = useSuspenseQuery(listLabelsQuery()).data;
  const allIssues = useSuspenseQuery(listIssuesQuery(issue.project.id)).data;
  const attachments = useSuspenseQuery(
    listIssueAttachmentsQuery(issue.id)
  ).data;
  const testRuns = useSuspenseQuery(listIssueTestRunsQuery(issue.id)).data;
  const jiraLink = useSuspenseQuery(getJiraLinkQuery(issue.project.id)).data;
  // Viewers read issues; changing one takes `issue: write` (as the server).
  const roles = useSuspenseQuery(getMyProjectAccessQuery()).data.roles;
  const canEdit = canProject(roles[issue.project.id] ?? null, {
    issue: ["write"],
  });
  // Only rendered when this specific issue is mirrored — a linked project can
  // still hold issues that were created here and never pushed.
  const jiraUrl =
    issue.jiraKey && jiraLink
      ? `${jiraLink.connection.baseUrl}/browse/${issue.jiraKey}`
      : null;
  const environments =
    project?.environments.map((e) => ({ id: e.id, name: e.name })) ?? [];
  // Candidate parents: every other issue in the project (self and descendants
  // are filtered client-side to keep the tree acyclic).
  const siblings = allIssues
    .filter((i) => i.id !== issue.id)
    .map((i) => ({ id: i.id, number: i.number, title: i.title }));

  return (
    <>
      <PageHeader
        title={`${issue.project.key}-${issue.number}`}
        subtitle={t("createdBy", {
          name: issue.createdBy?.name ?? t("unknownUser"),
        })}
        action={
          <div className="flex items-center gap-2">
            {jiraUrl && (
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <a href={jiraUrl} target="_blank" rel="noreferrer noopener" />
                }
              >
                <ExternalLink className="size-4" />
                {issue.jiraKey}
              </Button>
            )}
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/${issue.project.key}/issues`} />}
            >
              <ArrowLeft className="size-4" />
              {tIssues("title")}
            </Button>
          </div>
        }
      />
      <IssueDetailClient
        issue={issue}
        users={users}
        environments={environments}
        siblings={siblings}
        attachments={attachments}
        testRuns={testRuns}
        allLabels={allLabels}
        canEdit={canEdit}
        // Always from the server, bypassing the cache's freshness.
        onReload={() =>
          queryClient.fetchQuery({ ...detailQuery, staleTime: 0 })
        }
      />
    </>
  );
}

// The detail page has no ancestor `loading.tsx`, so without this one a click
// from the issue list hangs on the old page until every query resolves.
// Mirrors `issue-detail-client`: title and description in the main column,
// then comments; the properties sidebar from `lg`.
function IssuePending() {
  return (
    <>
      <PageHeaderSkeleton />
      <div className="grid w-full max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 max-w-3xl flex-col gap-6">
          <Skeleton className="h-8 w-2/3" />
          {/* The chip row below lg. */}
          <div className="flex flex-wrap gap-1.5 lg:hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={`chip-${i}`} className="h-6 w-20" />
            ))}
          </div>
          <Skeleton className="h-32 w-full" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: 2 }, (_, i) => (
              <div key={`comment-${i}`} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-12 w-full" />
              </div>
            ))}
          </div>
        </div>
        {/* Status, priority, assignee, type, labels, environment. */}
        <div className="hidden flex-col gap-2 lg:flex">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={`row-${i}`} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </>
  );
}
