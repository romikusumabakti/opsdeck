import { Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getJiraConnections } from "@/actions/jira";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/auth-session";
import { JiraClient } from "./jira-client";

export default async function JiraPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const connections = await getJiraConnections();
  const t = await getTranslations("jira");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Button render={<Link href="/jira/new" />}>
            <Plus className="size-4" />
            {t("addConnection")}
          </Button>
        }
      />
      <JiraClient connections={connections} />
    </>
  );
}
