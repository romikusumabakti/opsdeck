import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getInstanceBackupsQuery,
  getInstanceUpdatesQuery,
} from "@/web/api/instance";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { BackupsTab } from "./-components/admin/instance/backups-tab";
import { UpdatesTab } from "./-components/admin/instance/updates-tab";
import { ListPending } from "./-components/list-pending";

// Admin → Instance: the Panel's own backups and updates.
export const Route = createFileRoute("/$locale/_app/admin/instance")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { instance: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    // The update check may wait on GitHub: started here, not awaited; the
    // Updates tab suspends on it alone.
    void queryClient.prefetchQuery(getInstanceUpdatesQuery());
    await loaderQuery(queryClient, getInstanceBackupsQuery());
  },
  pendingComponent: () => <ListPending />,
  component: InstancePage,
});

function InstancePage() {
  const t = useTranslations("instance");
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Tabs defaultValue="backups" className="w-full">
        <TabsList>
          <TabsTrigger value="backups">{t("tabBackups")}</TabsTrigger>
          <TabsTrigger value="updates">{t("tabUpdates")}</TabsTrigger>
        </TabsList>
        <TabsContent value="backups">
          <BackupsTab />
        </TabsContent>
        <TabsContent value="updates">
          <Suspense fallback={<ListPending />}>
            <UpdatesTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}
