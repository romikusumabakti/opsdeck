import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { getProjectTasks } from "@/actions/tasks";
import { PageHeader } from "@/components/page-header";
import { HistoryClient } from "./history-client";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);

  const [project, tasks, t, tCommon] = await Promise.all([
    getProjectById(projectId),
    getProjectTasks(projectId),
    getTranslations("history"),
    getTranslations("common"),
  ]);

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <HistoryClient tasks={tasks} />
    </div>
  );
}
