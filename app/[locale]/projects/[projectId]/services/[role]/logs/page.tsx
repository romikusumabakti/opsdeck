import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import {
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { type InitialLogState, LogsClient } from "./logs-client";

const VALID_ROLES = ["db", "backend", "frontend"] as const;

const ROLE_TITLE_KEY = {
  db: "database",
  backend: "backend",
  frontend: "frontend",
} as const;

function roleConfig(project: SafeProjectWithServers, role: ServiceRole) {
  if (role === "db") {
    return {
      serviceName: project.dbServiceName,
      serverName: project.dbServer.name,
    };
  }
  if (role === "backend") {
    return {
      serviceName: project.backendServiceName,
      serverName: project.backendServer.name,
    };
  }
  return {
    serviceName: project.frontendServiceName,
    serverName: project.frontendServer.name,
  };
}

function parseTail(raw: string | string[] | undefined): LogLines {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (LOG_LINE_OPTIONS as readonly number[]).includes(n)
    ? (n as LogLines)
    : 200;
}

function parseLevel(
  raw: string | string[] | undefined
): InitialLogState["level"] {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "error" || v === "warn" || v === "info" || v === "debug") return v;
  return "all";
}

function str(raw: string | string[] | undefined): string {
  return typeof raw === "string" ? raw : "";
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; projectId: string; role: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, projectId, role } = await params;
  setRequestLocale(locale);

  if (!VALID_ROLES.includes(role as ServiceRole)) notFound();
  const typedRole = role as ServiceRole;

  const [project, sp, t, tDash, tCommon] = await Promise.all([
    getProjectById(projectId),
    searchParams,
    getTranslations("services"),
    getTranslations("dashboard"),
    getTranslations("common"),
  ]);

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const { serviceName, serverName } = roleConfig(project, typedRole);
  const target = tDash(ROLE_TITLE_KEY[typedRole]);

  const initial: InitialLogState = {
    tail: parseTail(sp.tail),
    q: str(sp.q),
    level: parseLevel(sp.level),
    view:
      (Array.isArray(sp.view) ? sp.view[0] : sp.view) === "raw"
        ? "raw"
        : "pretty",
  };

  return (
    <>
      <PageHeader
        title={t("logs.title", { target })}
        subtitle={t("logs.pageSubtitle", { serviceName, serverName })}
        action={
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}/services`}>
              <ArrowLeft className="size-4" />
              {t("logs.backToServices")}
            </Link>
          </Button>
        }
      />
      <LogsClient
        project={project}
        role={typedRole}
        serviceName={serviceName}
        initial={initial}
      />
    </>
  );
}
