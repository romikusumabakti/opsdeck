import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ArrowLeft, Folder, ServerCog } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { ServerForm } from "@/components/server-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { qualifiedEnvName } from "@/lib/nav-path";
import { canOrg } from "@/lib/permissions";
import { getServerByIdQuery, getServerUsageQuery } from "@/web/api/servers";
import { useMe } from "@/web/api/session";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { ServerPending } from "./-components/servers/skeletons";

export const Route = createFileRoute("/$locale/_app/servers/$id/")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { server: ["read"] }),
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const [server] = await Promise.all([
      orNotFound(queryClient.query(getServerByIdQuery(id))),
      orNotFound(queryClient.query(getServerUsageQuery(id))),
    ]);
    if (!server) throw notFound();
  },
  pendingComponent: ServerPending,
  component: EditServerPage,
});

function EditServerPage() {
  const { id } = Route.useParams();
  const t = useTranslations("editServer");
  const tForm = useTranslations("serverForm");
  const tDash = useTranslations("dashboard");
  const me = useMe();
  // Observers (server:read) see the details read-only.
  const canManage = canOrg(me?.orgRole, { server: ["manage"] });
  const server = useSuspenseQuery(getServerByIdQuery(id)).data;
  const usage = useSuspenseQuery(getServerUsageQuery(id)).data;
  if (!server) return null;

  return (
    <>
      <PageHeader
        title={
          canManage
            ? t("title", { name: server.name })
            : t("viewTitle", { name: server.name })
        }
        subtitle={t("description")}
        action={
          <Button
            nativeButton={false}
            variant="outline"
            render={<Link href="/servers" />}
          >
            <ArrowLeft className="size-4" />
            {t("backToServers")}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem] max-w-5xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ServerCog className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ServerForm mode={{ type: "edit", server }} readOnly={!canManage} />
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              {tForm("usageTitle")}{" "}
              <span className="text-muted-foreground font-normal">
                ({usage.length})
              </span>
            </CardTitle>
            <CardDescription>{tForm("usageDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {usage.length === 0 ? (
              <EmptyState
                icon={Folder}
                title={tForm("usageEmptyTitle")}
                description={tForm("usageEmptyDescription")}
                className="py-10"
              />
            ) : (
              <ul className="divide-y border-t">
                {usage.map((u) => (
                  <li
                    key={u.environment.id}
                    className="flex items-center justify-between gap-2 px-6 py-3"
                  >
                    <Link
                      href={`/${u.environment.projectKey}/${u.environment.slug}`}
                      className="font-medium truncate hover:underline"
                      title={qualifiedEnvName(
                        u.environment.name,
                        u.environment.projectName
                      )}
                    >
                      {qualifiedEnvName(
                        u.environment.name,
                        u.environment.projectName
                      )}
                    </Link>
                    <span className="flex flex-wrap gap-1 shrink-0">
                      {u.roles.map((r) => (
                        <Badge key={r} variant="secondary" className="text-xs">
                          {tDash(r === "db" ? "database" : r)}
                        </Badge>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
