import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";
import { getEnvironmentById } from "@/actions/environments";
import { PageHeader } from "@/components/page-header";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { DashboardKpis, DashboardKpisSkeleton } from "./dashboard-kpis";
import { EnvironmentStack } from "./environment-stack";
import { RecentActivity, RecentActivitySkeleton } from "./recent-activity";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  const envPath = `/${projectKey}/${envSlug}`;
  setRequestLocale(locale);
  const environment = await getEnvironmentById(environmentId);
  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: environment.name })}
      />
      <Suspense fallback={<DashboardKpisSkeleton />}>
        <DashboardKpis environmentId={environmentId} />
      </Suspense>
      <EnvironmentStack environment={environment} envPath={envPath} />
      <Suspense fallback={<RecentActivitySkeleton />}>
        <RecentActivity environmentId={environmentId} envPath={envPath} />
      </Suspense>
    </>
  );
}
