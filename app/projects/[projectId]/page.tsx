import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";

export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = await getProjectById(parseInt(projectId));

  if (!project) {
    return <p>Project not found.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl">Dashboard</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">Database</h3>
          <p className="text-sm text-muted-foreground">
            {project.dbServer.name}
          </p>
          <p>{project.dbServer.host}</p>
          <p>{project.dbServiceName}</p>
        </Card>
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">Backend</h3>
          <p className="text-sm text-muted-foreground">
            {project.backendServer.name}
          </p>
          <p>{project.backendServer.host}</p>
          <p>{project.backendServiceName}</p>
        </Card>
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">Frontend</h3>
          <p className="text-sm text-muted-foreground">
            {project.frontendServer.name}
          </p>
          <p>{project.frontendServer.host}</p>
          <p>{project.frontendServiceName}</p>
        </Card>
      </div>
    </div>
  );
}
