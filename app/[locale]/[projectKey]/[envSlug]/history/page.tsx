import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import { getEnvironmentRuns } from "@/actions/runs";
import { PageHeader } from "@/components/page-header";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { HistoryClient } from "./history-client";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const [environment, runs, t, tCommon] = await Promise.all([
    getEnvironmentById(environmentId),
    getEnvironmentRuns(environmentId),
    getTranslations("history"),
    getTranslations("common"),
  ]);

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <HistoryClient runs={runs} />
    </>
  );
}
