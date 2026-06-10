"use client";

import { ArrowRight, Atom, Boxes, Database, Plug, Tag } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  getAllServiceStatuses,
  type ServiceStatusResult,
} from "@/actions/services";
import { ServiceStatusBadge } from "@/components/service-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import type { ServiceRole, ServiceType } from "@/lib/services";

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

export function ProjectStack({ project }: { project: SafeProjectWithServers }) {
  const t = useTranslations("dashboard.stack");
  const tDash = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const [statuses, setStatuses] = React.useState<StatusMap>({});
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAllServiceStatuses(project.id)
      .then((results) => {
        if (cancelled) return;
        const next: StatusMap = {};
        for (const r of results) next[r.role] = r;
        setStatuses(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project, tCommon]);

  const roles: RoleMeta[] = [
    {
      role: "db",
      icon: Database,
      titleKey: "database",
      serviceType: project.dbServiceType,
      serviceName: project.dbServiceName,
      serverName: project.dbServer.name,
      extra: (
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1 truncate">
          <Tag className="size-3 shrink-0" />
          {tDash(`dbTypes.${project.dbType}`)}
          <span aria-hidden="true">·</span>
          <code className="font-mono truncate">{project.dbName}</code>
        </span>
      ),
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">{t("title")}</CardTitle>
        </div>
        <Link
          href={`/projects/${project.id}/services`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
        >
          {t("manage")}
          <ArrowRight className="size-3" />
        </Link>
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
}: {
  meta: RoleMeta;
  status: ServiceStatusResult | null;
  loading: boolean;
  tDash: (key: string) => string;
}) {
  const Icon = meta.icon;
  const state = status?.state ?? "unknown";
  return (
    <div className="flex items-center gap-3 min-w-0">
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
      </div>
      <ServiceStatusBadge state={state} loading={loading} />
    </div>
  );
}

export function ProjectStackSkeleton() {
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
