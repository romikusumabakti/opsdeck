import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

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
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <div className="relative">
      <SidebarProvider className="h-[calc(100svh-3.5rem)] *:h-[calc(100svh-3.5rem)]">
        <AppSidebar project={project} />
        <main className="px-8 py-4 overflow-y-auto flex flex-col grow">
          {children}
        </main>
      </SidebarProvider>
    </div>
  );
}
