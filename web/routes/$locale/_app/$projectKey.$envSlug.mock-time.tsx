import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Clock, ServerCog } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import apiDocs from "@/docs/time-mocking-api.md?raw";
import { useProjectName } from "@/hooks/use-project-name";
import { stripProjectPrefix } from "@/lib/nav-path";
import { backendService } from "@/lib/services";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import { loaderQuery } from "@/web/query-client";
import { ApiDocsSheet } from "./-components/env/mock-time/api-docs-sheet";
import { MockTime } from "./-components/env/mock-time/mock-time";
import { MockTimePending } from "./-components/env/skeletons";

export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/mock-time"
)({
  loader: async ({ context: { queryClient, environmentId } }) => {
    await loaderQuery(queryClient, getEnvironmentByIdQuery(environmentId));
  },
  pendingComponent: MockTimePending,
  component: MockTimePage,
});

function MockTimePage() {
  const { environmentId } = Route.useRouteContext();
  const t = useTranslations("mockTime");
  const tCommon = useTranslations("common");
  const environment = useSuspenseQuery(
    getEnvironmentByIdQuery(environmentId)
  ).data;
  const projectName = useProjectName(environment?.projectId ?? "");

  if (!environment) {
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  const hasApi = Boolean(backendService(environment).mockTimeApiUrl?.trim());

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", {
          name: stripProjectPrefix(environment.name, projectName),
        })}
        action={<ApiDocsSheet content={apiDocs} />}
      />

      <Card className="max-w-4xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            <Badge
              variant={hasApi ? "outline" : "secondary"}
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
