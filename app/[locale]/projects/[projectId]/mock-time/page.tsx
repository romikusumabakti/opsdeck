import { readFile } from "node:fs/promises";
import path from "node:path";
import { Clock, Info, ServerCog } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cache } from "react";
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
import { ApiDocsSheet } from "./api-docs-sheet";
import { MockTime } from "./mock-time";

const getApiDocs = cache(async () => {
  try {
    return await readFile(
      path.join(process.cwd(), "docs", "time-mocking-api.md"),
      "utf-8"
    );
  } catch (error) {
    // The docs file ships via Next file tracing; if it's missing from the
    // deployed image, degrade gracefully rather than crashing the whole page.
    console.error("Failed to read time-mocking-api.md:", error);
    return "";
  }
});

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const [project, apiDocs] = await Promise.all([
    getProjectById(projectId),
    getApiDocs(),
  ]);
  const t = await getTranslations("mockTime");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const hasApi = Boolean(project.backendMockTimeApiUrl?.trim());

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
        action={<ApiDocsSheet content={apiDocs} />}
      />

      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            <Badge
              variant={hasApi ? "default" : "secondary"}
              className="ml-auto gap-1"
            >
              <ServerCog className="size-3" />
              {hasApi ? t("modeApi") : t("modeLegacy")}
            </Badge>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!hasApi && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <Info className="size-4 shrink-0 mt-0.5" />
              <p>{t("legacyWarning")}</p>
            </div>
          )}

          <MockTime project={project} />
        </CardContent>
      </Card>
    </>
  );
}
