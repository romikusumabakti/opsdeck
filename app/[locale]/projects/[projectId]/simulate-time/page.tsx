import { Clock, Info, ServerCog } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SimulateTime } from "./simulate-time";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("simulateTime");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const hasApi = Boolean(project.backendSimulateTimeApiUrl?.trim());

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
      />

      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <ServerCog className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">{t("modeLabel")}</span>
              <Badge variant={hasApi ? "default" : "secondary"}>
                {hasApi ? t("modeApi") : t("modeLegacy")}
              </Badge>
              <span className="text-xs text-muted-foreground mt-1">
                {hasApi
                  ? t("modeApiHint", {
                      url: project.backendSimulateTimeApiUrl ?? "",
                    })
                  : t("modeLegacyHint", { name: project.backendServiceName })}
              </span>
            </div>
          </div>

          <SimulateTime project={project} />

          {!hasApi && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <Info className="size-4 shrink-0 mt-0.5" />
              <p>{t("legacyWarning")}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
