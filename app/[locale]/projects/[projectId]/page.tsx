import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { Card } from "@/components/ui/card";
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
    <div className="flex flex-col gap-4">
      <h2 className="text-2xl">{t("title")}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">{t("database")}</h3>
          <RoleFields
            server={project.dbServer}
            serviceType={t(`serviceTypes.${project.dbServiceType}`)}
            serviceName={project.dbServiceName}
            labels={labels}
          />
          <Field label={t("dbType")}>{t(`dbTypes.${project.dbType}`)}</Field>
          <Field label={t("dbName")}>{project.dbName}</Field>
        </Card>
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">{t("backend")}</h3>
          <RoleFields
            server={project.backendServer}
            serviceType={t(`serviceTypes.${project.backendServiceType}`)}
            serviceName={project.backendServiceName}
            labels={labels}
          />
        </Card>
        <Card className="flex flex-col p-4 gap-2">
          <h3 className="font-bold">{t("frontend")}</h3>
          <RoleFields
            server={project.frontendServer}
            serviceType={t(`serviceTypes.${project.frontendServiceType}`)}
            serviceName={project.frontendServiceName}
            labels={labels}
          />
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

function RoleFields({
  server,
  serviceType,
  serviceName,
  labels,
}: {
  server: Server;
  serviceType: string;
  serviceName: string;
  labels: Labels;
}) {
  return (
    <>
      <Field label={labels.server}>{server.name}</Field>
      <Field label={labels.host}>{server.host}</Field>
      <Field label={labels.serviceType}>{serviceType}</Field>
      <Field label={labels.serviceName}>{serviceName}</Field>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span>{children}</span>
    </div>
  );
}
