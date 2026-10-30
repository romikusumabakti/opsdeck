import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Copy, FolderPlus } from "lucide-react";
import { useTranslations } from "use-intl";
import { EnvironmentForm } from "@/components/environment-form";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getEnvironmentByIdQuery } from "@/web/api/environments";
import {
  getProjectByKeyWithEnvironmentsQuery,
  listProjectsQuery,
} from "@/web/api/project-catalog";
import { getServersQuery } from "@/web/api/servers";
import { requireProjectRole } from "@/web/project-guard";

// New environment under a given project. The parent comes from the route, so
// the form's project picker starts on it; `?from=<envId>` clones an existing
// environment's configuration (possibly from another project).
export const Route = createFileRoute(
  "/$locale/_app/$projectKey/environments/new"
)({
  validateSearch: (search: Record<string, unknown>): { from?: string } => ({
    from:
      typeof search.from === "string" && search.from ? search.from : undefined,
  }),
  loaderDeps: ({ search: { from } }) => ({ from }),
  // A new environment binds servers and their credentials: org server:manage
  // too, not just the project role.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(
      queryClient,
      project.id,
      { environment: ["create"] },
      { server: ["manage"] }
    );
  },
  loader: async ({ deps: { from }, context: { queryClient } }) => {
    await Promise.all([
      queryClient.query(getServersQuery()),
      queryClient.query(listProjectsQuery()),
      from ? queryClient.query(getEnvironmentByIdQuery(from)) : null,
    ]);
  },
  pendingComponent: NewEnvironmentPending,
  component: NewEnvironmentPage,
});

function NewEnvironmentPage() {
  const { projectKey } = Route.useParams();
  const { from } = Route.useSearch();
  const t = useTranslations("newEnvironment");
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  const servers = useSuspenseQuery(getServersQuery()).data;
  const projects = useSuspenseQuery(listProjectsQuery()).data;
  // Only read when `?from` names a source: the loader fetched it then.
  const cloneFrom =
    useQuery({ ...getEnvironmentByIdQuery(from ?? ""), enabled: Boolean(from) })
      .data ?? undefined;
  if (!project) throw notFound();

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
            canManageServers
            projects={projects}
            defaultProjectId={project.id}
          />
        </CardContent>
      </Card>
    </>
  );
}

function NewEnvironmentPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-sm" />
            <Skeleton className="h-5 w-32" />
          </div>
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <FormSection fields={1} />
          <FormSection fields={6} />
          <FormSection fields={4} />
          <FormSection fields={3} />
          <div className="flex justify-end gap-2">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-32" />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function FormSection({ fields }: { fields: number }) {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-4 w-24" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
