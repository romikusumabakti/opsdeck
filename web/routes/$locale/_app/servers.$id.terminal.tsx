import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { ServerTerminal } from "@/components/server-terminal";
import { getServerByIdQuery } from "@/web/api/servers";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { TerminalPending } from "./-components/servers/skeletons";

export const Route = createFileRoute("/$locale/_app/servers/$id/terminal")({
  validateSearch: (search: Record<string, unknown>): { cwd?: string } => ({
    cwd: typeof search.cwd === "string" ? search.cwd : undefined,
  }),
  // The ticket endpoint checks this too — this keeps the page itself off
  // limits, so a non-admin never sees a terminal that would refuse to connect.
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { server: ["terminal"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const server = await orNotFound(queryClient.query(getServerByIdQuery(id)));
    if (!server) throw notFound();
  },
  pendingComponent: TerminalPending,
  component: ServerTerminalPage,
});

function ServerTerminalPage() {
  const { id } = Route.useParams();
  const { cwd } = Route.useSearch();
  const t = useTranslations("terminal");
  const server = useSuspenseQuery(getServerByIdQuery(id)).data;
  if (!server) return null;

  return (
    <>
      <PageHeader
        title={t("title", { name: server.name })}
        subtitle={t("subtitle", {
          username: server.username,
          host: server.host,
        })}
      />
      <ServerTerminal serverId={id} cwd={cwd} />
    </>
  );
}
