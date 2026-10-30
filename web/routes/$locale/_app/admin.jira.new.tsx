import { createFileRoute } from "@tanstack/react-router";
import { Cable } from "lucide-react";
import { useTranslations } from "use-intl";
import { JiraConnectionForm } from "@/components/jira-connection-form";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/admin/jira/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  component: NewJiraConnectionPage,
});

function NewJiraConnectionPage() {
  const t = useTranslations("newJira");
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
