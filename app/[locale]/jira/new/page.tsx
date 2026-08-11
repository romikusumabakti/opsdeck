import { Cable } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
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

export default async function NewJiraConnectionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const t = await getTranslations("newJira");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("description")} />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Cable className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <JiraConnectionForm mode={{ type: "create" }} />
        </CardContent>
      </Card>
    </>
  );
}
