import { readFile } from "node:fs/promises";
import path from "node:path";
import { Clock, ServerCog } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cache } from "react";
import { getEnvironmentById } from "@/actions/environments";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { backendService } from "@/lib/services";
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
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);
  const [environment, apiDocs] = await Promise.all([
    getEnvironmentById(environmentId),
    getApiDocs(),
  ]);
  const t = await getTranslations("mockTime");
  const tCommon = await getTranslations("common");

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  const hasApi = Boolean(backendService(environment).mockTimeApiUrl?.trim());

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: environment.name })}
        action={<ApiDocsSheet content={apiDocs} />}
      />

      <Card className="max-w-4xl w-full">
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
          <MockTime environment={environment} />
        </CardContent>
      </Card>
    </>
  );
}
