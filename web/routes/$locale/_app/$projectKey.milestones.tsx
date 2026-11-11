import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { listMilestonesQuery } from "@/web/api/milestones";
import { getProjectByKeyWithEnvironmentsQuery } from "@/web/api/project-catalog";
import { requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { MilestonesClient } from "./-components/project/milestones-client";

export const Route = createFileRoute("/$locale/_app/$projectKey/milestones")({
  // 404 when the project is unknown or invisible to the caller.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(queryClient, project.id);
  },
  loader: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await loaderQuery(queryClient, listMilestonesQuery(project.id));
  },
  pendingComponent: MilestonesPending,
  component: ProjectMilestonesPage,
});

function ProjectMilestonesPage() {
  const { projectKey } = Route.useParams();
  const t = useTranslations("projectOverview");
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  if (!project) throw notFound();
  const milestones = useSuspenseQuery(listMilestonesQuery(project.id)).data;

  return (
    <>
      <PageHeader title={t("milestones")} subtitle={project.name} />
      <MilestonesClient projectId={project.id} initialMilestones={milestones} />
    </>
  );
}

function MilestonesPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Skeleton className="h-64 w-full rounded-lg" />
    </>
  );
}
