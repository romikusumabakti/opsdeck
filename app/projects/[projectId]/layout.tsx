import { getProjectById } from "@/actions/projects";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export default async function Layout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}>) {
  const { projectId } = await params;
  const project = await getProjectById(projectId);

  if (!project) {
    return <p>Project not found.</p>;
  }

  return (
    <div className="relative overflow-y-auto">
      <SidebarProvider className="overflow-y-auto h-[calc(100vh-64px)] *:h-[calc(100vh-64px)]">
        <AppSidebar project={project} />
        <main className="px-8 py-4 overflow-y-auto flex flex-col grow">
          {children}
        </main>
      </SidebarProvider>
    </div>
  );
}
