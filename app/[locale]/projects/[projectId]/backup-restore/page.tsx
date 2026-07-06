import { redirect } from "@/i18n/navigation";

// Backup + restore now live on the Databases page (backup is a per-database row
// action, restore is a section below the list). Keep this route as a redirect
// so existing bookmarks and history links still resolve.
export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { projectId } = await params;
  await redirect(`/projects/${projectId}/databases?tab=backup`);
}
