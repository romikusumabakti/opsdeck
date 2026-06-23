import { redirect } from "@/i18n/navigation";

// Backup + restore were merged into a single tabbed page. Keep this route as a
// redirect so existing bookmarks and history links still resolve.
export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { projectId } = await params;
  await redirect(`/projects/${projectId}/backup-restore?tab=restore`);
}
