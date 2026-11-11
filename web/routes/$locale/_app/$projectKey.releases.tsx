import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProjectRoleProvider } from "@/components/project-role";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { getProjectByKeyWithEnvironmentsQuery } from "@/web/api/project-catalog";
import { listProjectReleasesQuery } from "@/web/api/releases";
import { requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ReleasesList } from "./-components/releases/releases-list";

export const Route = createFileRoute("/$locale/_app/$projectKey/releases")({
  // Listing releases needs deploy:view, the same as the API. A project page
  // sits outside the environment layout, so it brings its own role context.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    const role = await requireProjectRole(queryClient, project.id, {
      deploy: ["view"],
    });
    return { projectId: project.id, role };
  },
  loader: async ({ context: { queryClient, projectId } }) => {
    await loaderQuery(queryClient, listProjectReleasesQuery(projectId));
  },
  pendingComponent: ReleasesPending,
  component: ReleasesPage,
});

function ReleasesPage() {
  const { projectId, role } = Route.useRouteContext();
  return (
    <ProjectRoleProvider role={role}>
      <ReleasesList projectId={projectId} />
    </ProjectRoleProvider>
  );
}

function ReleasesPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Skeleton className="h-48 w-full rounded-lg" />
    </>
  );
}
