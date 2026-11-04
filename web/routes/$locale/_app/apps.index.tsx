import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Boxes, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { listAppsQuery, useCanRegisterApp } from "@/web/api/apps";
import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";
import { loaderQuery } from "@/web/query-client";
import { PipelineFileStatus } from "./-components/apps/pipeline-file-status";
import { ListPending } from "./-components/list-pending";

export const Route = createFileRoute("/$locale/_app/apps/")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listAppsQuery()),
      loaderQuery(queryClient, meQuery()),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
    ]);
  },
  pendingComponent: () => <ListPending columns={5} />,
  component: AppsPage,
});

function AppsPage() {
  const t = useTranslations("apps");
  const apps = useSuspenseQuery(listAppsQuery()).data;
  const canRegister = useCanRegisterApp();

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          canRegister ? (
            <Button nativeButton={false} render={<Link href="/apps/new" />}>
              <Plus className="size-4" />
              {t("register")}
            </Button>
          ) : undefined
        }
      />
      {apps.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Boxes}
            title={t("emptyTitle")}
            description={t("empty")}
          />
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colApp")}</TableHead>
                <TableHead>{t("colComponent")}</TableHead>
                <TableHead>{t("colRepo")}</TableHead>
                <TableHead>{t("colMode")}</TableHead>
                <TableHead>{t("colPipelineFile")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.flatMap((app) => {
                const appCell = (
                  <Link
                    href={`/apps/${app.appKey}`}
                    className="font-medium hover:underline"
                  >
                    {app.name}
                  </Link>
                );
                if (app.components.length === 0) {
                  return [
                    <TableRow key={app.id}>
                      <TableCell>{appCell}</TableCell>
                      <TableCell
                        colSpan={4}
                        className="text-sm text-muted-foreground"
                      >
                        {t("noComponents")}
                      </TableCell>
                    </TableRow>,
                  ];
                }
                return app.components.map((component, index) => (
                  <TableRow key={component.componentKey}>
                    <TableCell>{index === 0 ? appCell : null}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {component.componentKey}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {component.repoFullName}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {component.pipelineMode === "generated"
                          ? t("modeGenerated")
                          : t("modeCustom")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <PipelineFileStatus component={component} />
                    </TableCell>
                  </TableRow>
                ));
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
