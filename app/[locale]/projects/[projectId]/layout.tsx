import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";

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
      <div className="px-4 sm:px-8 py-6">
        <p>{tCommon("projectNotFound")}</p>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-8 py-6 flex flex-col gap-6">{children}</div>
  );
}
