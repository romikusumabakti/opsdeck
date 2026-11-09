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
import { SshKeyTab } from "./-components/admin/instance/ssh-key-tab";
import { UpdatesTab } from "./-components/admin/instance/updates-tab";
import { ListPending } from "./-components/list-pending";

// Admin → Instance: the Panel's own backups, updates and SSH key. The SSH key
// tab's routes check org server:manage, which every instance:manage role has.
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
          <TabsTrigger value="ssh-key">{t("tabSshKey")}</TabsTrigger>
        </TabsList>
        <TabsContent value="backups">
          <BackupsTab />
        </TabsContent>
        <TabsContent value="updates">
          <Suspense fallback={<ListPending />}>
            <UpdatesTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="ssh-key">
          <Suspense fallback={<ListPending />}>
            <SshKeyTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </>
  );
}
