import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Cable, Webhook } from "lucide-react";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { JiraConnectionForm } from "@/components/jira-connection-form";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getJiraConnectionQuery, getJiraWebhookUrlQuery } from "@/web/api/jira";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/admin/jira/$id")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const connection = await orNotFound(
      queryClient.query(getJiraConnectionQuery(id))
    );
    if (!connection) throw notFound();
    // Admin-only, and only rendered on the edit page: the URL contains the
    // shared secret that authenticates inbound deliveries.
    await loaderQuery(queryClient, getJiraWebhookUrlQuery(id));
  },
  component: EditJiraConnectionPage,
});

function EditJiraConnectionPage() {
  const { id } = Route.useParams();
  const t = useTranslations("editJira");
  const connection = useSuspenseQuery(getJiraConnectionQuery(id)).data;
  const webhookUrl = useSuspenseQuery(getJiraWebhookUrlQuery(id)).data;
  if (!connection) return null;

  return (
    <>
      <PageHeader
        title={t("title", { name: connection.name })}
        subtitle={t("description")}
      />
      <div className="flex flex-col gap-4 max-w-2xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cable className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <JiraConnectionForm mode={{ type: "edit", connection }} />
          </CardContent>
        </Card>

        {webhookUrl && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Webhook className="size-5 text-muted-foreground" />
                <CardTitle className="text-base">{t("webhookTitle")}</CardTitle>
              </div>
              <CardDescription>{t("webhookDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs">
                  {webhookUrl}
                </code>
                <CopyButton value={webhookUrl} />
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t("webhookStep1")}</li>
                <li>{t("webhookStep2")}</li>
                <li>{t("webhookStep3")}</li>
              </ol>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
