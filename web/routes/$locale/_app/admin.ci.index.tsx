import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Pencil, Workflow } from "lucide-react";
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
import { listCiConnectionsQuery } from "@/web/api/ci-connections";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ListPending } from "./-components/list-pending";

export const Route = createFileRoute("/$locale/_app/admin/ci/")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listCiConnectionsQuery());
  },
  pendingComponent: () => <ListPending />,
  component: CiPage,
});

function CiPage() {
  const t = useTranslations("ci");
  const tCommon = useTranslations("common");
  const connections = useSuspenseQuery(listCiConnectionsQuery()).data;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {connections.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Workflow}
            title={t("emptyTitle")}
            description={t("empty")}
          />
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colBaseUrl")}</TableHead>
                <TableHead>{t("colCredentials")}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {c.baseUrl}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={c.hasApiToken ? "secondary" : "outline"}>
                        {c.hasApiToken ? t("apiTokenSet") : t("apiTokenNotSet")}
                      </Badge>
                      <Badge
                        variant={c.hasExtensionKey ? "secondary" : "outline"}
                      >
                        {c.hasExtensionKey ? t("keyStored") : t("keyMissing")}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/ci/${c.id}`}
                      className="inline-flex items-center gap-1 text-sm hover:underline"
                    >
                      <Pencil className="size-3.5" />
                      {tCommon("edit")}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
