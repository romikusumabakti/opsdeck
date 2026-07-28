"use client";

import {
  Atom,
  CircleAlert,
  Database,
  FileText,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  ServerCog,
  Square,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  controlService,
  getAllServiceStatuses,
  type ServiceStatusResult,
} from "@/actions/services";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { PageHeader } from "@/components/page-header";
import { ServiceStatusBadge } from "@/components/service-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import {
  backendService,
  dbService,
  frontendService,
  type ServiceAction,
  type ServiceRole,
  type ServiceType,
} from "@/lib/services";
import { cn } from "@/lib/utils";

type RoleMeta = {
  role: ServiceRole;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: "database" | "backend" | "frontend";
  serviceType: ServiceType;
  serviceName: string;
  serverName: string;
};

type StatusMap = Partial<Record<ServiceRole, ServiceStatusResult>>;

export function ServicesClient({
  project,
}: {
  project: SafeEnvironmentWithServers;
}) {
  const t = useTranslations("services");
  const tCommon = useTranslations("common");
  const [statuses, setStatuses] = React.useState<StatusMap>({});
  const [loading, setLoading] = React.useState(true);

  const dbSvc = dbService(project);
  const backendSvc = backendService(project);
  const frontendSvc = frontendService(project);

  const roles: RoleMeta[] = [
    {
      role: "db",
      icon: Database,
      titleKey: "database",
      serviceType: dbSvc.serviceType,
      serviceName: dbSvc.serviceName,
      serverName: dbSvc.server.name,
    },
    {
      role: "backend",
      icon: Plug,
      titleKey: "backend",
      serviceType: backendSvc.serviceType,
      serviceName: backendSvc.serviceName,
      serverName: backendSvc.server.name,
    },
    {
      role: "frontend",
      icon: Atom,
      titleKey: "frontend",
      serviceType: frontendSvc.serviceType,
      serviceName: frontendSvc.serviceName,
      serverName: frontendSvc.server.name,
    },
  ];

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const results = await getAllServiceStatuses(project.id);
      const next: StatusMap = {};
      for (const r of results) next[r.role] = r;
      setStatuses(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tCommon("errorGeneric"));
    } finally {
      setLoading(false);
    }
  }, [project, tCommon]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { name: project.name })}
        action={
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            {t("refresh")}
          </Button>
        }
      />
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground max-w-3xl">
        <ServerCog className="size-4 shrink-0 mt-0.5" />
        <p>{t("infoNote")}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {roles.map((meta) => (
          <ServiceCard
            key={meta.role}
            project={project}
            meta={meta}
            status={statuses[meta.role] ?? null}
            loading={loading}
            onRefresh={refresh}
          />
        ))}
      </div>
    </>
  );
}

function ServiceCard({
  project,
  meta,
  status,
  loading,
  onRefresh,
}: {
  project: SafeEnvironmentWithServers;
  meta: RoleMeta;
  status: ServiceStatusResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("services");
  const tDash = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const dialog = useDialog();

  const [pendingAction, setPendingAction] =
    React.useState<ServiceAction | null>(null);
  // The action that owns the currently-open run dialog. Kept separate from
  // pendingAction (which clears once the action handler returns) so the
  // dialog title can keep displaying e.g. "Restart" until the user closes it.
  const [activeTask, setActiveTask] = React.useState<{
    runId: string;
    action: ServiceAction;
  } | null>(null);

  async function onAction(action: ServiceAction) {
    const titleLabel = tDash(meta.titleKey);
    const ok = await dialog.confirm({
      title: t(`confirmTitle.${action}`),
      description: t("confirmDescription", {
        action: t(`actions.${action}`),
        target: titleLabel,
        serviceName: meta.serviceName,
      }),
      confirmText: t(`actions.${action}`),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    setPendingAction(action);
    try {
      const { runId: newTaskId } = await controlService(
        project.id,
        meta.role,
        action
      );
      setActiveTask({ runId: newTaskId, action });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tCommon("errorGeneric"));
    } finally {
      setPendingAction(null);
    }
  }

  const state = status?.state ?? "unknown";
  const Icon = meta.icon;
  const busy = loading || pendingAction !== null;
  // Closing the dialog (X / ESC / overlay-click) clears the run and re-fetches
  // status. The run itself keeps running server-side even if the user dismisses
  // early — refresh will surface the eventual final state.
  function onOpenChange(open: boolean) {
    if (!open) {
      setActiveTask(null);
      onRefresh();
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="size-5 text-muted-foreground shrink-0" />
            <CardTitle className="text-base truncate">
              {tDash(meta.titleKey)}
            </CardTitle>
          </div>
          <ServiceStatusBadge state={state} loading={loading} />
        </div>
        <CardDescription className="truncate">
          <code className="font-mono text-xs">{meta.serviceName}</code>
          <span className="text-muted-foreground"> · {meta.serverName}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">
          <span className="uppercase tracking-wide">{t("typeLabel")}</span>{" "}
          <Badge variant="secondary">
            {tDash(`serviceTypes.${meta.serviceType}`)}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAction("start")}
            disabled={busy || state === "running"}
            aria-label={t("actions.start")}
          >
            {pendingAction === "start" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {t("actions.start")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAction("stop")}
            disabled={busy || state === "stopped" || state === "not-found"}
            aria-label={t("actions.stop")}
          >
            {pendingAction === "stop" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-4" />
            )}
            {t("actions.stop")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAction("restart")}
            disabled={busy || state === "not-found"}
            aria-label={t("actions.restart")}
            className="col-span-2"
          >
            {pendingAction === "restart" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            {t("actions.restart")}
          </Button>
          {state === "not-found" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled
              aria-label={t("actions.viewLogs")}
              className="col-span-2"
            >
              <FileText className="size-4" />
              {t("actions.viewLogs")}
            </Button>
          ) : (
            <Button
              render={
                <Link
                  href={`/projects/${project.id}/services/${meta.role}/logs`}
                  aria-label={t("actions.viewLogs")}
                />
              }
              size="sm"
              variant="ghost"
              className="col-span-2"
            >
              <FileText className="size-4" />
              {t("actions.viewLogs")}
            </Button>
          )}
        </div>

        {status?.error && (
          <div className="text-xs text-destructive flex items-start gap-1.5">
            <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
            <code className="font-mono break-all">{status.error}</code>
          </div>
        )}
      </CardContent>

      <LiveRunDialog
        runId={activeTask?.runId ?? null}
        onOpenChange={onOpenChange}
        title={
          activeTask
            ? t(`confirmTitle.${activeTask.action}`)
            : tDash(meta.titleKey)
        }
        description={
          <>
            <code className="font-mono text-xs">{meta.serviceName}</code>
            <span>· {meta.serverName}</span>
          </>
        }
      />
    </Card>
  );
}
