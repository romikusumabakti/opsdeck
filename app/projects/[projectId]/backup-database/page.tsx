import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";
import { BackupDatabase } from "./backup-database";

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

  return (
    <Card className="p-8">
      <h1 className="text-2xl">Create database backup</h1>
      <p>Create backup for database: {project.dbName}</p>
      <BackupDatabase project={project} />
    </Card>
  );
}
