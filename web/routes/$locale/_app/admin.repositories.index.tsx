import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Boxes } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { listAppsQuery } from "@/web/api/apps";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { PipelineFileStatus } from "./-components/apps/pipeline-file-status";
import { ListPending } from "./-components/list-pending";

// The repositories the Panel builds and deploys (an app per repository set),
// under admin: org integration:manage, like the pipeline actions and variable
// templates on its detail pages. A repository is registered by creating the
// first environment from it.
export const Route = createFileRoute("/$locale/_app/admin/repositories/")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listAppsQuery());
  },
  pendingComponent: () => <ListPending columns={5} />,
  component: RepositoriesPage,
});

function RepositoriesPage() {
  const t = useTranslations("apps");
  const apps = useSuspenseQuery(listAppsQuery()).data;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
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
                    href={`/admin/repositories/${app.appKey}`}
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
