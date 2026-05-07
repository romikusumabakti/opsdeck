import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export default async function Layout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string; projectId: string }>;
}>) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);

  const project = await getProjectById(projectId);

  if (!project) {
    const tCommon = await getTranslations("common");
    return (
      <div className="px-8 py-6">
        <p>{tCommon("projectNotFound")}</p>
      </div>
    );
  }

  return (
    <SidebarProvider className="flex-1 min-h-0">
      <AppSidebar activeProject={project} />
      <SidebarInset>
        <div className="flex items-center gap-2 px-4 py-2 md:hidden border-b">
          <SidebarTrigger />
          <span className="text-sm font-medium truncate">{project.name}</span>
        </div>
        <div className="px-4 sm:px-8 py-6 flex flex-col gap-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
