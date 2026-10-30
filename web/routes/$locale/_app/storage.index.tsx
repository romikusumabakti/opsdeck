import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { getS3ConnectionsQuery } from "@/web/api/s3-connections";
import { useMe } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ListPending } from "./-components/list-pending";
import { StorageClient } from "./-components/storage/storage-client";

export const Route = createFileRoute("/$locale/_app/storage/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { storage: ["read"] }),
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, getS3ConnectionsQuery());
  },
  pendingComponent: () => <ListPending />,
  component: StoragePage,
});

function StoragePage() {
  const t = useTranslations("storage");
  const me = useMe();
  const connections = useSuspenseQuery(getS3ConnectionsQuery()).data;
  // storage:read (observers) lists connections; managing them and browsing
  // their files need their own statements, so those controls are hidden too.
  const can = {
    manage: canOrg(me?.orgRole, { storage: ["manage"] }),
    files: canOrg(me?.orgRole, { storage: ["files"] }),
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          can.manage ? (
            <Button nativeButton={false} render={<Link href="/storage/new" />}>
              <Plus className="size-4" />
              {t("addConnection")}
            </Button>
          ) : undefined
        }
      />
      <StorageClient connections={connections} can={can} />
    </>
  );
}
