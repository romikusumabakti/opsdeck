import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { getServersQuery } from "@/web/api/servers";
import { useMe } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { ListPending } from "./-components/list-pending";
import { ServersClient } from "./-components/servers/servers-client";

export const Route = createFileRoute("/$locale/_app/servers/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { server: ["read"] }),
  loader: async ({ context: { queryClient } }) => {
    await queryClient.query(getServersQuery());
  },
  pendingComponent: () => <ListPending />,
  component: ServersPage,
});

function ServersPage() {
  const t = useTranslations("servers");
  const me = useMe();
  const servers = useSuspenseQuery(getServersQuery()).data;
  // server:read (observers) lists servers; managing, the terminal and the file
  // browser each need their own statement, so their controls are hidden too.
  const can = {
    manage: canOrg(me?.orgRole, { server: ["manage"] }),
    terminal: canOrg(me?.orgRole, { server: ["terminal"] }),
    files: canOrg(me?.orgRole, { server: ["files"] }),
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          can.manage ? (
            <Button nativeButton={false} render={<Link href="/servers/new" />}>
              <Plus className="size-4" />
              {t("addServer")}
            </Button>
          ) : undefined
        }
      />
      <ServersClient servers={servers} can={can} />
    </>
  );
}
