import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getIssueDetail } from "@/actions/issues";
import { listLabels } from "@/actions/labels";
import { listMilestones } from "@/actions/milestones";
import { getProjectWithEnvironments } from "@/actions/project-catalog";
import { listAssignableUsers } from "@/actions/users";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { IssueDetailClient } from "./issue-detail-client";

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ locale: string; key: string; number: string }>;
}) {
  const { locale, key, number } = await params;
  setRequestLocale(locale);

  const n = Number.parseInt(number, 10);
  if (!Number.isInteger(n) || n <= 0) {
    notFound();
  }

  const issue = await getIssueDetail(key, n);
  if (!issue) {
    notFound();
  }

  const [project, users, allLabels, milestones, t] = await Promise.all([
    getProjectWithEnvironments(issue.project.id),
    listAssignableUsers(),
    listLabels(),
    listMilestones(issue.project.id),
    getTranslations("issueDetail"),
  ]);
  const environments =
    project?.environments.map((e) => ({ id: e.id, name: e.name })) ?? [];

  return (
    <>
      <PageHeader
        title={`${issue.project.key}-${issue.number}`}
        subtitle={t("createdBy", {
          name: issue.createdBy?.name ?? t("unknownUser"),
        })}
        action={
          <Button
            variant="outline"
            render={<Link href={`/project/${issue.project.key}`} />}
          >
            <ArrowLeft className="size-4" />
            {issue.project.name}
          </Button>
        }
      />
      <IssueDetailClient
        issue={issue}
        users={users}
        environments={environments}
        milestones={milestones.map((m) => ({ id: m.id, name: m.name }))}
        allLabels={allLabels}
      />
    </>
  );
}
