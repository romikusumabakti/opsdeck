import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { ServicesClient } from "./services-client";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);
  const environment = await getEnvironmentById(environmentId);
  const tCommon = await getTranslations("common");

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  return (
    <ServicesClient
      environment={environment}
      envPath={`/${projectKey}/${envSlug}`}
    />
  );
}
