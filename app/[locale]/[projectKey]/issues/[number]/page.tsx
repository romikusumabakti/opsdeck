import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { listIssueAttachments } from "@/actions/issue-attachments";
import { getIssueDetail, listIssues } from "@/actions/issues";
import { getJiraLink } from "@/actions/jira";
import { listLabels } from "@/actions/labels";
import { listMilestones } from "@/actions/milestones";
import { getProjectWithEnvironments } from "@/actions/project-catalog";
import { listIssueTestRuns } from "@/actions/test-runs";
import { listAssignableUsers } from "@/actions/users";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { IssueDetailClient } from "./issue-detail-client";

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; number: string }>;
}) {
  const { locale, projectKey, number } = await params;
  setRequestLocale(locale);

  const n = Number.parseInt(number, 10);
  if (!Number.isInteger(n) || n <= 0) {
    notFound();
  }

  const issue = await getIssueDetail(projectKey, n);
  if (!issue) {
    notFound();
  }

  const [
    project,
    users,
    allLabels,
    milestones,
    allIssues,
    attachments,
    testRuns,
    jiraLink,
    t,
  ] = await Promise.all([
    getProjectWithEnvironments(issue.project.id),
    listAssignableUsers(),
    listLabels(),
    listMilestones(issue.project.id),
    listIssues(issue.project.id),
    listIssueAttachments(issue.id),
    listIssueTestRuns(issue.id),
    getJiraLink(issue.project.id),
    getTranslations("issueDetail"),
  ]);
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
              render={<Link href={`/${issue.project.key}`} />}
            >
              <ArrowLeft className="size-4" />
              {issue.project.name}
            </Button>
          </div>
        }
      />
      <IssueDetailClient
        issue={issue}
        users={users}
        environments={environments}
        milestones={milestones.map((m) => ({ id: m.id, name: m.name }))}
        siblings={siblings}
        attachments={attachments}
        testRuns={testRuns}
        allLabels={allLabels}
      />
    </>
  );
}
