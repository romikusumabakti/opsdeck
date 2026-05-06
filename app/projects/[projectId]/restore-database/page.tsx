import { getBackupList } from "@/actions/backups";
import { getProjectById } from "@/actions/projects";
import { RestoreDatabase } from "@/app/projects/[projectId]/restore-database/restore-database";
import { Card } from "@/components/ui/card";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = await getProjectById(projectId);

  if (!project) {
    return <p>Project not found.</p>;
  }

  const backups = (await getBackupList(project)).data;

  if (!backups) {
    return <p>Backups not found.</p>;
  }

  return (
    <Card className="p-8">
      <h1 className="text-2xl">Restore database backup</h1>
      <RestoreDatabase backups={backups} />
    </Card>
  );
}
