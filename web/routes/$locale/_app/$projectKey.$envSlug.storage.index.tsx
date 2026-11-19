import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { SECTION_PERMS } from "@/lib/nav-path";
import { canProject } from "@/lib/permissions";
import { environmentStorageQuery } from "@/web/api/environment-storage";
import { loaderQuery } from "@/web/query-client";
import { StorageList } from "./-components/env/storage/storage-list";
import { ListPending } from "./-components/list-pending";

// An environment's storage connections. Anyone who sees the environment sees
// the list; the controls follow the caller's role on the project.
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/$envSlug/storage/"
)({
  loader: async ({ context: { queryClient, environmentId } }) => {
    await loaderQuery(queryClient, environmentStorageQuery(environmentId));
  },
  pendingComponent: () => <ListPending />,
  component: StoragePage,
});

function StoragePage() {
  const { projectKey, envSlug } = Route.useParams();
  const { environmentId, role } = Route.useRouteContext();
  const t = useTranslations("storage");
  const connections = useSuspenseQuery(
    environmentStorageQuery(environmentId)
  ).data;
  const basePath = `/${projectKey}/${envSlug}/storage`;
  const canManage = canProject(role, SECTION_PERMS.settings);
  // Browsing shows the bucket's objects, as reading the variables shows its
  // secrets: both take the same project right.
  const canBrowse = canProject(role, SECTION_PERMS.variables);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          canManage && connections.length > 0 ? (
            <Button
              nativeButton={false}
              render={<Link href={`${basePath}/new`} />}
            >
              <Plus className="size-4" />
              {t("addConnection")}
            </Button>
          ) : undefined
        }
      />
      <StorageList
        environmentId={environmentId}
        basePath={basePath}
        connections={connections}
        canManage={canManage}
        canBrowse={canBrowse}
      />
    </>
  );
}
