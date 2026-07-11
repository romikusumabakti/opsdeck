import { notFound, redirect } from "next/navigation";
import { resolveKeySlugById } from "@/lib/env-url";

// Legacy environment URLs (`/projects/[envId]/…`) permanently redirect to the
// canonical readable route (`/[projectKey]/[envSlug]/…`) so old bookmarks and
// stored hrefs keep working after the URL migration.
export default async function LegacyEnvRedirect({
  params,
}: {
  params: Promise<{ locale: string; projectId: string; rest?: string[] }>;
}) {
  const { locale, projectId, rest } = await params;
  const parts = await resolveKeySlugById(projectId);
  if (!parts) notFound();
  const tail = rest?.length ? `/${rest.join("/")}` : "";
  redirect(`/${locale}/${parts.projectKey}/${parts.envSlug}${tail}`);
}
