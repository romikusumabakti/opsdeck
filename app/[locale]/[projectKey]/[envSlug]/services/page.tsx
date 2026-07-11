import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { ServicesClient } from "./services-client";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const projectId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return <ServicesClient project={project} />;
}
