import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AppRegisterForm } from "@/components/app-register-form";
import { PageHeader } from "@/components/page-header";
import { listCiConnectionOptionsQuery } from "@/web/api/apps";
import { requireAppRegistrant } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/apps/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireAppRegistrant(queryClient);
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listCiConnectionOptionsQuery());
  },
  component: RegisterAppPage,
});

function RegisterAppPage() {
  const t = useTranslations("appForm");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("description")} />
      <div className="max-w-3xl w-full">
        <AppRegisterForm />
      </div>
    </>
  );
}
