"use client";

import {
  AlertTriangle,
  CircleCheck,
  Globe,
  Link2Off,
  Loader2,
  Plug,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  attachTunnelNetwork,
  deleteTunnelRoute,
  type RouteRow,
  type TunnelRoutesView,
} from "@/actions/tunnels";
import { useDialog } from "@/components/dialog-provider";
import { TunnelRouteDialog } from "@/components/tunnel-route-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRouter } from "@/i18n/navigation";
import type { TunnelWithContext } from "@/lib/db/schema";
import type { ContainerInfo } from "@/lib/tunnels/remote";

export type OriginCandidate = ContainerInfo & { reachable: boolean };

export function RoutesClient({
  tunnel,
  view,
  candidates,
}: {
  tunnel: TunnelWithContext;
  view: TunnelRoutesView;
  candidates: OriginCandidate[];
}) {
  const t = useTranslations("tunnels");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [addOpen, setAddOpen] = React.useState(false);

  const onDelete = React.useCallback(
    async (route: RouteRow) => {
      const ok = await dialog.confirmTyping({
        title: t("routeDeleteTitle"),
        description: t("routeDeleteDescription", { hostname: route.hostname }),
        phrase: route.hostname,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        const result = await deleteTunnelRoute({
          tunnelId: tunnel.id,
          hostname: route.hostname,
        });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
        router.refresh();
      });
    },
    [dialog, t, tCommon, tunnel.id, router]
  );

  const onAttachNetwork = React.useCallback(
    async (network: string) => {
      const ok = await dialog.confirm({
        title: t("attachNetworkTitle"),
        description: t("attachNetworkDescription", {
          network,
          container: tunnel.containerName,
        }),
        confirmText: t("attachNetworkConfirm"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        const result = await attachTunnelNetwork({
          tunnelId: tunnel.id,
          network,
        });
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
        router.refresh();
      });
    },
    [dialog, t, tCommon, tunnel.id, tunnel.containerName, router]
  );

  if (view.error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>{t("readFailedTitle")}</AlertTitle>
        <AlertDescription>{view.error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <HealthBadge
            state={view.containerState}
            ready={view.ready}
            label={{
              running: t("tunnelHealthy"),
              degraded: t("tunnelDegraded"),
              stopped: t("tunnelStopped"),
              missing: t("tunnelMissing", { container: tunnel.containerName }),
            }}
          />
          <span className="text-xs text-muted-foreground font-mono">
            {tunnel.stackDir}/{tunnel.configPath}
          </span>
        </div>
        <Button onClick={() => setAddOpen(true)} disabled={isPending}>
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {t("addHostname")}
        </Button>
      </div>

      {view.routes.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Globe}
            title={t("routesEmptyTitle")}
            description={t("routesEmpty")}
            action={
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="size-4" />
                {t("addHostname")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colHostname")}</TableHead>
                <TableHead>{t("colOrigin")}</TableHead>
                <TableHead>{t("colDns")}</TableHead>
                <TableHead>{t("colReachable")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.routes.map((route) => (
                <TableRow key={route.hostname}>
                  <TableCell>
                    <a
                      href={`https://${route.hostname}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline"
                    >
                      {route.hostname}
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {route.service}
                    {route.originState === "not-found" && (
                      <Badge variant="destructive" className="ml-2">
                        {t("originMissing")}
                      </Badge>
                    )}
                    {route.originState === "stopped" && (
                      <Badge variant="secondary" className="ml-2">
                        {t("originStopped")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DnsBadge route={route} />
                  </TableCell>
                  <TableCell>
                    {route.reachable === null ? (
                      <span className="text-muted-foreground text-xs">—</span>
                    ) : route.reachable ? (
                      <Badge variant="secondary">
                        <Plug className="size-3" />
                        {t("reachableYes")}
                      </Badge>
                    ) : (
                      // The 502-at-the-edge case. Offer the fix inline rather
                      // than only naming the problem.
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isPending || !route.origin}
                        onClick={() => {
                          const container = candidates.find(
                            (c) => c.name === route.origin?.host
                          );
                          const network = container?.networks[0];
                          if (network) onAttachNetwork(network);
                        }}
                      >
                        <Link2Off className="size-3 text-destructive" />
                        {t("reachableNo")}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tCommon("delete")}
                      title={tCommon("delete")}
                      disabled={isPending}
                      onClick={() => onDelete(route)}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <TunnelRouteDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        tunnel={tunnel}
        candidates={candidates}
        existing={view.routes.map((r) => r.hostname)}
        onDone={() => router.refresh()}
      />
    </div>
  );
}

function HealthBadge({
  state,
  ready,
  label,
}: {
  state: TunnelRoutesView["containerState"];
  ready: boolean | null;
  label: {
    running: string;
    degraded: string;
    stopped: string;
    missing: string;
  };
}) {
  if (state === "not-found") {
    return <Badge variant="destructive">{label.missing}</Badge>;
  }
  if (state === "stopped") {
    return <Badge variant="destructive">{label.stopped}</Badge>;
  }
  if (ready) {
    return (
      <Badge variant="secondary">
        <CircleCheck className="size-3" />
        {label.running}
      </Badge>
    );
  }
  return <Badge variant="destructive">{label.degraded}</Badge>;
}

function DnsBadge({ route }: { route: RouteRow }) {
  const t = useTranslations("tunnels");
  switch (route.dns.state) {
    case "ok":
      return <Badge variant="secondary">{t("dnsOk")}</Badge>;
    case "missing":
      // Ingress without DNS: the route serves nothing because nothing resolves.
      return <Badge variant="destructive">{t("dnsMissing")}</Badge>;
    case "mismatch":
      // The dangerous one — the hostname resolves somewhere this tunnel does
      // not serve, so what users reach is not what this table describes.
      return (
        <Badge variant="destructive" title={route.dns.record.content}>
          {t("dnsMismatch")}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" title={route.dns.message}>
          {t("dnsUnknown")}
        </Badge>
      );
  }
}
