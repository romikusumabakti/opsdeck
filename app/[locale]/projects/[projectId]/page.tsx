import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl">{t("title")}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">{t("database")}</h3>
          <p className="text-sm text-muted-foreground">
            {project.dbServer.name}
          </p>
          <p>{project.dbServer.host}</p>
          <p>{project.dbServiceName}</p>
        </Card>
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">{t("backend")}</h3>
          <p className="text-sm text-muted-foreground">
            {project.backendServer.name}
          </p>
          <p>{project.backendServer.host}</p>
          <p>{project.backendServiceName}</p>
        </Card>
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">{t("frontend")}</h3>
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
