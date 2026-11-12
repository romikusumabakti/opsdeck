import {
  Atom,
  Boxes,
  CircleAlert,
  Database,
  Plug,
  RefreshCw,
  Tag,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { ServiceStatusBadge } from "@/components/service-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  findService,
  type ServiceRole,
  type ServiceType,
} from "@/lib/services";
import { cn } from "@/lib/utils";
import type { EnvironmentWithServers } from "@/web/api/environments";
import {
  getAllServiceStatuses,
  type ServiceStatusResult,
} from "@/web/api/services";
import { type PendingServiceAction, ServiceActions } from "./service-actions";

type RoleMeta = {
  role: ServiceRole;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: "database" | "backend" | "frontend";
  serviceType: ServiceType;
  serviceName: string;
  serverName: string;
  extra?: React.ReactNode;
};

type StatusMap = Partial<Record<ServiceRole, ServiceStatusResult>>;

export function EnvironmentStack({
  environment,
  envPath,
}: {
  environment: EnvironmentWithServers;
  // Readable base path of the environment (`/[projectKey]/[envSlug]`).
  envPath: string;
}) {
  const t = useTranslations("dashboard.stack");
  const tDash = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const tServices = useTranslations("services");
  const [statuses, setStatuses] = React.useState<StatusMap>({});
  const [loading, setLoading] = React.useState(true);
  // One action at a time across the whole card.
  const [pending, setPending] = React.useState<PendingServiceAction>(null);

  // Updates the rows in place: nothing unmounts while it runs, so an open run
  // dialog survives a refresh.
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const results = await getAllServiceStatuses(environment.id);
      const next: StatusMap = {};
      for (const r of results) next[r.role] = r;
      setStatuses(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tCommon("errorGeneric"));
    } finally {
      setLoading(false);
    }
  }, [environment, tCommon]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Only the services the environment has, in db, backend, frontend order.
  const dbSvc = findService(environment, "db");
  const backendSvc = findService(environment, "backend");
  const frontendSvc = findService(environment, "frontend");

  const roles: RoleMeta[] = [];
  if (dbSvc) {
    roles.push({
      role: "db",
      icon: Database,
      titleKey: "database",
      serviceType: dbSvc.serviceType,
      serviceName: dbSvc.serviceName,
      serverName: dbSvc.server.name,
      extra: (
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1 truncate">
          <Tag className="size-3 shrink-0" />
          {tDash(`dbTypes.${dbSvc.dbType ?? ""}`)}
          <span aria-hidden="true">·</span>
          <code className="font-mono truncate">{dbSvc.dbName ?? ""}</code>
        </span>
      ),
    });
  }
  if (backendSvc) {
    roles.push({
      role: "backend",
      icon: Plug,
      titleKey: "backend",
      serviceType: backendSvc.serviceType,
      serviceName: backendSvc.serviceName,
      serverName: backendSvc.server.name,
    });
  }
  if (frontendSvc) {
    roles.push({
      role: "frontend",
      icon: Atom,
      titleKey: "frontend",
      serviceType: frontendSvc.serviceType,
      serviceName: frontendSvc.serviceName,
      serverName: frontendSvc.server.name,
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">{t("title")}</CardTitle>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                onClick={refresh}
                disabled={loading}
              />
            }
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            {tServices("refresh")}
          </TooltipTrigger>
          <TooltipContent>{tServices("infoNote")}</TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {roles.map((meta, i) => (
            <li
              key={meta.role}
              className={i === 0 ? "py-3" : "py-3 border-t border-border/40"}
            >
              <StackRow
                meta={meta}
                status={statuses[meta.role] ?? null}
                loading={loading}
                tDash={tDash}
                actions={
                  <ServiceActions
                    environmentId={environment.id}
                    role={meta.role}
                    title={tDash(meta.titleKey)}
                    serviceName={meta.serviceName}
                    serverName={meta.serverName}
                    status={statuses[meta.role] ?? null}
                    loading={loading}
                    logsHref={`${envPath}/services/${meta.role}/logs`}
                    pending={pending}
                    onPendingChange={setPending}
                    onRefresh={refresh}
                  />
                }
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function StackRow({
  meta,
  status,
  loading,
  tDash,
  actions,
}: {
  meta: RoleMeta;
  status: ServiceStatusResult | null;
  loading: boolean;
  tDash: (key: string) => string;
  actions: React.ReactNode;
}) {
  const Icon = meta.icon;
  const state = status?.state ?? "unknown";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
      <div className="flex flex-1 basis-64 items-center gap-3 min-w-0">
        <span className="size-9 rounded-md bg-muted/60 flex items-center justify-center shrink-0">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">
              {tDash(meta.titleKey)}
            </span>
            <Badge
              variant="secondary"
              className="text-[10px] uppercase tracking-wide shrink-0"
            >
              {tDash(`serviceTypes.${meta.serviceType}`)}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground truncate">
            <code className="font-mono">{meta.serviceName}</code>
            <span> · {meta.serverName}</span>
          </span>
          {meta.extra}
          {status?.error && (
            <div className="text-xs text-destructive flex items-start gap-1.5">
              <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
              <code className="font-mono break-all">{status.error}</code>
            </div>
          )}
        </div>
        <ServiceStatusBadge state={state} loading={loading} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 ps-12 sm:ps-0">
        {actions}
      </div>
    </div>
  );
}

export function EnvironmentStackSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 py-1">
            <Skeleton className="size-9 rounded-md shrink-0" />
            <div className="flex-1 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
