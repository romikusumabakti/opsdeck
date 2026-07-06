import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById, recordProjectAccess } from "@/actions/projects";

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

  // Project confirmed to exist (valid FK) — bump its recency for this user so
  // the header switcher lists it first. Runs on segment entry, not on client
  // nav between sibling pages, which matches "opened this project".
  await recordProjectAccess(projectId);

  return <>{children}</>;
}
