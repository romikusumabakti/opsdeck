import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { getProjectRuns } from "@/actions/runs";
import { PageHeader } from "@/components/page-header";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { HistoryClient } from "./history-client";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const projectId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const [project, runs, t, tCommon] = await Promise.all([
    getProjectById(projectId),
    getProjectRuns(projectId),
    getTranslations("history"),
    getTranslations("common"),
  ]);

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <HistoryClient runs={runs} />
    </>
  );
}
