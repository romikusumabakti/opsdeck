"use client";

import {
  Atom,
  CircleAlert,
  CircleHelp,
  Database,
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
import { LiveTaskPanel } from "@/components/live-task-panel";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ProjectWithServers } from "@/lib/db/schema";
import type { ServiceAction, ServiceRole, ServiceState } from "@/lib/services";
import { cn } from "@/lib/utils";

type RoleMeta = {
  role: ServiceRole;
  icon: React.ComponentType<{ className?: string }>;
  titleKey: "database" | "backend" | "frontend";
  serviceType: "docker" | "system";
  serviceName: string;
  serverName: string;
};

type StatusMap = Partial<Record<ServiceRole, ServiceStatusResult>>;

export function ServicesClient({ project }: { project: ProjectWithServers }) {
  const t = useTranslations("services");
  const tCommon = useTranslations("common");
  const [statuses, setStatuses] = React.useState<StatusMap>({});
  const [loading, setLoading] = React.useState(true);

  const roles: RoleMeta[] = [
    {
      role: "db",
      icon: Database,
      titleKey: "database",
      serviceType: project.dbServiceType,
      serviceName: project.dbServiceName,
      serverName: project.dbServer.name,
    },
    {
      role: "backend",
      icon: Plug,
      titleKey: "backend",
      serviceType: project.backendServiceType,
      serviceName: project.backendServiceName,
      serverName: project.backendServer.name,
    },
    {
      role: "frontend",
      icon: Atom,
      titleKey: "frontend",
      serviceType: project.frontendServiceType,
      serviceName: project.frontendServiceName,
      serverName: project.frontendServer.name,
    },
  ];

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const results = await getAllServiceStatuses(project);
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
  project: ProjectWithServers;
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
  const [taskId, setTaskId] = React.useState<string | null>(null);

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
      const { taskId: newTaskId } = await controlService(
        project,
        meta.role,
        action
      );
      setTaskId(newTaskId);
      toast.success(t(`successTitle.${action}`), {
        description: t("successDescription", {
          action: t(`actions.${action}`),
          serviceName: meta.serviceName,
        }),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tCommon("errorGeneric"));
    } finally {
      setPendingAction(null);
    }
  }

  const state = status?.state ?? "unknown";
  const Icon = meta.icon;
  const busy = loading || pendingAction !== null;
  // After a control task finishes, refresh state — wired via LiveTaskPanel's
  // dismiss callback so users can click X to close *and* trigger a refetch.
  function onPanelDismiss() {
    setTaskId(null);
    onRefresh();
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
          <StatusBadge state={state} loading={loading} t={t} />
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
            variant="default"
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
        </div>

        {status?.error && (
          <div className="text-xs text-destructive flex items-start gap-1.5">
            <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
            <code className="font-mono break-all">{status.error}</code>
          </div>
        )}

        {taskId && (
          <LiveTaskPanel
            key={taskId}
            taskId={taskId}
            onDismiss={onPanelDismiss}
          />
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  state,
  loading,
  t,
}: {
  state: ServiceState;
  loading: boolean;
  t: (key: string) => string;
}) {
  if (loading) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        {t("states.checking")}
      </Badge>
    );
  }
  if (state === "running") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 border-transparent gap-1">
        <span
          className="size-1.5 rounded-full bg-emerald-500"
          aria-hidden="true"
        />
        {t("states.running")}
      </Badge>
    );
  }
  if (state === "stopped") {
    return (
      <Badge variant="secondary" className="gap-1">
        <span
          className="size-1.5 rounded-full bg-muted-foreground"
          aria-hidden="true"
        />
        {t("states.stopped")}
      </Badge>
    );
  }
  if (state === "not-found") {
    return (
      <Badge variant="destructive" className="gap-1">
        <CircleAlert className="size-3" />
        {t("states.notFound")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <CircleHelp className="size-3" />
      {t("states.unknown")}
    </Badge>
  );
}
