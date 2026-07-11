import { redirect } from "@/i18n/navigation";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";

// Backup + restore were merged into the Databases page. Keep this route as a
// redirect so existing bookmarks and history links still resolve.
export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { projectKey, envSlug } = await params;
  const projectId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  await redirect(`/projects/${projectId}/databases?tab=backup`);
}
