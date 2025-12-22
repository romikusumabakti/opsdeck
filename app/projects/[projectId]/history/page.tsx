import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

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
    <Card className="p-8">
      <h1 className="text-2xl">History</h1>
    </Card>
  );
}
