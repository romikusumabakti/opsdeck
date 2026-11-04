import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { KeyRound, Loader2, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "use-intl";
import { CiConnectionForm } from "@/components/ci-connection-form";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DATE_TIME } from "@/lib/format-date";
import {
  listCiConnectionsQuery,
  refreshCiExtensionKey,
} from "@/web/api/ci-connections";
import { ApiError } from "@/web/api/client";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/admin/ci/$id")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ params: { id }, context: { queryClient } }) => {
    const connections = await loaderQuery(
      queryClient,
      listCiConnectionsQuery()
    );
    if (!connections?.some((c) => c.id === id)) throw notFound();
  },
  component: EditCiConnectionPage,
});

function EditCiConnectionPage() {
  const { id } = Route.useParams();
  const t = useTranslations("editCi");
  const format = useFormatter();
  const connection = useSuspenseQuery(listCiConnectionsQuery()).data.find(
    (c) => c.id === id
  );
  const [refreshing, setRefreshing] = useState(false);
  if (!connection) return null;

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refreshCiExtensionKey(id);
      toast.success(t("keyRefreshed"));
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
      } else {
        throw error;
      }
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("title", { name: connection.name })}
        subtitle={t("description")}
      />
      <div className="flex flex-col gap-4 max-w-2xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Workflow className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <CiConnectionForm connection={connection} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <KeyRound className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("keyTitle")}</CardTitle>
            </div>
            <CardDescription>{t("keyDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing || !connection.hasApiToken}
            >
              {refreshing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("refreshKey")}
            </Button>
            <span className="text-sm text-muted-foreground">
              {connection.extensionPublicKeyFetchedAt
                ? t("keyFetchedAt", {
                    time: format.dateTime(
                      new Date(connection.extensionPublicKeyFetchedAt),
                      DATE_TIME
                    ),
                  })
                : t("keyNeverFetched")}
            </span>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
