import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import { DashboardKpis, DashboardKpisSkeleton } from "./dashboard-kpis";
import { ProjectStack } from "./project-stack";
import { RecentActivity, RecentActivitySkeleton } from "./recent-activity";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
      />
      <Suspense fallback={<DashboardKpisSkeleton />}>
        <DashboardKpis projectId={projectId} />
      </Suspense>
      <ProjectStack project={project} />
      <Suspense fallback={<RecentActivitySkeleton />}>
        <RecentActivity projectId={projectId} />
      </Suspense>
    </>
  );
}
