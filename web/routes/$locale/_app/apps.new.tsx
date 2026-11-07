import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { canOrg } from "@/lib/permissions";
import {
  listCiConnectionOptionsQuery,
  projectsToAddEnvironmentTo,
  useCanManagePipelines,
} from "@/web/api/apps";
import {
  getMyProjectAccessQuery,
  listProjectsWithEnvironmentsQuery,
} from "@/web/api/project-catalog";
import { useMe } from "@/web/api/session";
import { requireAppRegistrant } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { NewAppStepper } from "./-components/setup/new-app-stepper";

// New app: a stepper that registers the app, sets up its first environment
// and starts the first build.
export const Route = createFileRoute("/$locale/_app/apps/new")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireAppRegistrant(queryClient);
  },
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listCiConnectionOptionsQuery()),
      loaderQuery(queryClient, listProjectsWithEnvironmentsQuery()),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
    ]);
  },
  component: NewAppPage,
});

function NewAppPage() {
  const t = useTranslations("setupWizard.newApp");
  const me = useMe();
  const canGenerate = useCanManagePipelines();
  const connections = useSuspenseQuery(listCiConnectionOptionsQuery()).data;
  const projects = useSuspenseQuery(listProjectsWithEnvironmentsQuery()).data;
  const access = useSuspenseQuery(getMyProjectAccessQuery()).data;
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <NewAppStepper
        connections={connections}
        projects={projectsToAddEnvironmentTo(projects, access.roles)}
        canGenerate={canGenerate}
        canPublish={canOrg(me?.orgRole, { server: ["manage"] })}
      />
    </>
  );
}
