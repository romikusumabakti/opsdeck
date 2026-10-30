import { createFileRoute } from "@tanstack/react-router";
import { ServerCog } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { ServerForm } from "@/components/server-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireOrgRole } from "@/web/project-guard";

export const Route = createFileRoute("/$locale/_app/servers/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { server: ["manage"] });
  },
  component: NewServerPage,
});

function NewServerPage() {
  const t = useTranslations("newServer");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("description")} />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ServerCog className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ServerForm mode={{ type: "create" }} />
        </CardContent>
      </Card>
    </>
  );
}
