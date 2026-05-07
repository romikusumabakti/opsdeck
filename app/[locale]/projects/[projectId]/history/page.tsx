import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { getProjectTasks } from "@/actions/tasks";
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
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <HistoryClient tasks={tasks} />
    </div>
  );
}
