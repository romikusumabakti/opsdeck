import { getTranslations, setRequestLocale } from "next-intl/server";
import { listIssues } from "@/actions/issues";
import { listMilestones } from "@/actions/milestones";
import { getProjectWithEnvironments } from "@/actions/project-catalog";
import { getProjectById } from "@/actions/projects";
import { listAssignableUsers } from "@/actions/users";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { IssuesClient } from "./issues-client";

export default async function IssuesPage({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const projectId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);
  await requireSession();

  const tCommon = await getTranslations("common");

  // The route param is an environment id (historically a "project"); issues
  // live on its parent logical project and are shared across its environments.
  const env = await getProjectById(projectId);
  if (!env) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const [project, issues, users, milestones] = await Promise.all([
    getProjectWithEnvironments(env.projectId),
    listIssues(env.projectId),
    listAssignableUsers(),
    listMilestones(env.projectId),
  ]);
  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const t = await getTranslations("issues");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <IssuesClient
        projectId={project.id}
        projectKey={project.key}
        currentEnvironmentId={env.id}
        environments={project.environments.map((e) => ({
          id: e.id,
          name: e.name,
        }))}
        users={users}
        milestones={milestones.map((m) => ({ id: m.id, name: m.name }))}
        initialIssues={issues}
      />
    </>
  );
}
