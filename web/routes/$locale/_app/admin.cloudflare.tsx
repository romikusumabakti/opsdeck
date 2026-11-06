import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Cloud } from "lucide-react";
import { useTranslations } from "use-intl";
import { CloudflareAccountForm } from "@/components/cloudflare-account-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  cloudflareTunnelsQuery,
  getCloudflareAccountQuery,
} from "@/web/api/cloudflare-account";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/admin/cloudflare")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { server: ["manage"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, getCloudflareAccountQuery());
  },
  component: CloudflarePage,
});

function CloudflarePage() {
  const t = useTranslations("cloudflareAccount");
  const account = useSuspenseQuery(getCloudflareAccountQuery()).data;

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex flex-col gap-4 max-w-2xl w-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Cloud className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <CloudflareAccountForm account={account} />
          </CardContent>
        </Card>
        {account?.hasToken && <TunnelsCard />}
      </div>
    </>
  );
}

function TunnelsCard() {
  const t = useTranslations("cloudflareAccount");
  const tunnels = useQuery(cloudflareTunnelsQuery());

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("tunnelsTitle")}</CardTitle>
        <CardDescription>{t("tunnelsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {tunnels.isPending && (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}
        {tunnels.isError && (
          <p className="text-sm text-destructive">{tunnels.error.message}</p>
        )}
        {tunnels.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("tunnelsEmpty")}</p>
        )}
        {tunnels.data && tunnels.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>{t("colManagement")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tunnels.data.map((tunnel) => (
                <TableRow key={tunnel.id}>
                  <TableCell>
                    <div className="font-medium">{tunnel.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {tunnel.id}
                    </div>
                  </TableCell>
                  <TableCell>{tunnel.status}</TableCell>
                  <TableCell>
                    <Badge
                      variant={tunnel.remoteConfig ? "secondary" : "outline"}
                    >
                      {tunnel.remoteConfig ? t("remote") : t("local")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
