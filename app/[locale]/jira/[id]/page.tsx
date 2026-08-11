import { Cable, Webhook } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getJiraConnection, getJiraWebhookUrl } from "@/actions/jira";
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
import { requireAdmin } from "@/lib/auth-session";

export default async function EditJiraConnectionPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const connection = await getJiraConnection(id);
  if (!connection) notFound();

  // Admin-only, and only rendered on the edit page: the URL contains the shared
  // secret that authenticates inbound deliveries.
  const webhookUrl = await getJiraWebhookUrl(id);
  const t = await getTranslations("editJira");

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
