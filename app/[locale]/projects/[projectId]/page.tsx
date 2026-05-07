import {
  Atom,
  Database,
  Layers,
  Network,
  Plug,
  Server as ServerIcon,
  Tag,
} from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Server } from "@/lib/db/schema";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const project = await getProjectById(projectId);
  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");

  if (!project) {
    return <p>{tCommon("projectNotFound")}</p>;
  }

  const labels = {
    server: t("server"),
    host: t("host"),
    serviceType: t("serviceType"),
    serviceName: t("serviceName"),
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("subtitle", { name: project.name })}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <Database className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{t("database")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ServerSummary server={project.dbServer} labels={labels} />
            <ServiceSummary
              type={project.dbServiceType}
              name={project.dbServiceName}
              labels={labels}
              t={t}
            />
            <Field icon={Tag} label={t("dbType")}>
              <Badge variant="secondary">
                {t(`dbTypes.${project.dbType}`)}
              </Badge>
            </Field>
            <Field icon={Layers} label={t("dbName")}>
              <code className="font-mono text-sm">{project.dbName}</code>
            </Field>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <Plug className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{t("backend")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ServerSummary server={project.backendServer} labels={labels} />
            <ServiceSummary
              type={project.backendServiceType}
              name={project.backendServiceName}
              labels={labels}
              t={t}
            />
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <Atom className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">{t("frontend")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ServerSummary server={project.frontendServer} labels={labels} />
            <ServiceSummary
              type={project.frontendServiceType}
              name={project.frontendServiceName}
              labels={labels}
              t={t}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type Labels = {
  server: string;
  host: string;
  serviceType: string;
  serviceName: string;
};

function ServerSummary({ server, labels }: { server: Server; labels: Labels }) {
  return (
    <>
      <Field icon={ServerIcon} label={labels.server}>
        {server.name}
      </Field>
      <Field icon={Network} label={labels.host}>
        <span className="flex items-center gap-1">
          <code className="font-mono text-sm">{server.host}</code>
          <CopyButton value={server.host} label={labels.host} />
        </span>
      </Field>
    </>
  );
}

function ServiceSummary({
  type,
  name,
  labels,
  t,
}: {
  type: "docker" | "system";
  name: string;
  labels: Labels;
  t: (key: string) => string;
}) {
  return (
    <>
      <Field icon={Tag} label={labels.serviceType}>
        <Badge variant="secondary">{t(`serviceTypes.${type}`)}</Badge>
      </Field>
      <Field icon={Layers} label={labels.serviceName}>
        <code className="font-mono text-sm">{name}</code>
      </Field>
    </>
  );
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground inline-flex items-center gap-1.5">
        <Icon className="size-3" />
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}
