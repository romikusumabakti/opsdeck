import { Copy, FolderPlus } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getEnvironmentById } from "@/actions/environments";
import {
  getProjectByKeyWithEnvironments,
  listProjects,
} from "@/actions/project-catalog";
import { getServers } from "@/actions/servers";
import { EnvironmentForm } from "@/components/environment-form";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth-session";

// New environment under a given project. The parent comes from the route, so
// the form's project picker starts on it; `?from=<envId>` clones an existing
// environment's configuration (possibly from another project).
export default async function NewEnvironmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; projectKey: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const [{ locale, projectKey }, { from }] = await Promise.all([
    params,
    searchParams,
  ]);
  setRequestLocale(locale);

  await requireAdmin();

  const t = await getTranslations("newEnvironment");
  const [servers, projects, project, cloneFrom] = await Promise.all([
    getServers(),
    listProjects(),
    getProjectByKeyWithEnvironments(projectKey),
    from ? getEnvironmentById(from) : Promise.resolve(undefined),
  ]);
  if (!project) {
    notFound();
  }

  const isCloning = Boolean(cloneFrom);

  return (
    <>
      <PageHeader
        title={isCloning ? t("cloneTitle") : t("title")}
        subtitle={
          isCloning && cloneFrom
            ? t("cloneDescription", { name: cloneFrom.name })
            : t("description")
        }
      />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            {isCloning ? (
              <Copy className="size-5 text-muted-foreground" />
            ) : (
              <FolderPlus className="size-5 text-muted-foreground" />
            )}
            <CardTitle className="text-base">
              {isCloning ? t("cloneFormTitle") : t("formTitle")}
            </CardTitle>
          </div>
          <CardDescription>
            {isCloning ? t("cloneFormDescription") : t("formDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EnvironmentForm
            mode={{ type: "create", cloneFrom: cloneFrom ?? undefined }}
            servers={servers}
            projects={projects}
            defaultProjectId={project.id}
          />
        </CardContent>
      </Card>
    </>
  );
}
