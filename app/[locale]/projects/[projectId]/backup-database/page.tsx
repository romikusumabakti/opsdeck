import { Database, Info } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BackupDatabase } from "./backup-database";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("backupDb");
  const tDash = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl w-full mx-auto">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("subtitle", { dbName: project.dbName })}
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("targetTitle")}</CardTitle>
          </div>
          <CardDescription>{t("targetDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {tDash("dbType")}
              </dt>
              <dd>
                <Badge variant="secondary">
                  {tDash(`dbTypes.${project.dbType}`)}
                </Badge>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {tDash("dbName")}
              </dt>
              <dd>
                <code className="font-mono text-sm">{project.dbName}</code>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {tDash("server")}
              </dt>
              <dd className="truncate">{project.dbServer.name}</dd>
            </div>
          </dl>
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="size-4 shrink-0 mt-0.5" />
            <p>{t("infoNote")}</p>
          </div>
          <div className="flex justify-end">
            <BackupDatabase project={project} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
