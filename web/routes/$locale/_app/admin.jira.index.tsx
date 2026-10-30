import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getJiraConnectionsQuery } from "@/web/api/jira";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { JiraClient } from "./-components/admin/jira/jira-client";
import { ListPending } from "./-components/list-pending";

export const Route = createFileRoute("/$locale/_app/admin/jira/")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, getJiraConnectionsQuery());
  },
  pendingComponent: () => <ListPending />,
  component: JiraPage,
});

function JiraPage() {
  const t = useTranslations("jira");
  const connections = useSuspenseQuery(getJiraConnectionsQuery()).data;

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button nativeButton={false} render={<Link href="/admin/jira/new" />}>
            <Plus className="size-4" />
            {t("addConnection")}
          </Button>
        }
      />
      <JiraClient connections={connections} />
    </>
  );
}
