import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { listEnvironmentsQuery } from "@/web/api/environments";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { unassignedS3ConnectionsQuery } from "@/web/api/s3-connections";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { UnassignedStorage } from "./-components/admin/storage/unassigned-storage";
import { ListPending } from "./-components/list-pending";

// Admin › Storage: connections no environment owns. Environments manage their
// own connections; this page is where an orphaned one is given a new owner or
// removed (org storage:manage, as the API requires).
export const Route = createFileRoute("/$locale/_app/admin/storage")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { storage: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, unassignedS3ConnectionsQuery()),
      loaderQuery(queryClient, listEnvironmentsQuery()),
      loaderQuery(queryClient, listProjectsQuery()),
    ]);
  },
  pendingComponent: () => <ListPending />,
  component: AdminStoragePage,
});

function AdminStoragePage() {
  const t = useTranslations("adminStorage");
  const connections = useSuspenseQuery(unassignedS3ConnectionsQuery()).data;
  const environments = useSuspenseQuery(listEnvironmentsQuery()).data;
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  const options = environments.map((environment) => {
    const project = projects.find((p) => p.id === environment.projectId);
    const label = project
      ? `${project.name} / ${environment.name}`
      : environment.name;
    return {
      value: environment.id,
      label,
      keywords: `${environment.key} ${environment.slug}`,
    };
  });

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <UnassignedStorage connections={connections} environments={options} />
    </>
  );
}
