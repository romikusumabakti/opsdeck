import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { getProjectByKeyWithEnvironmentsQuery } from "@/web/api/project-catalog";
import {
  listMemberCandidatesQuery,
  listOrgWideAccessQuery,
  listProjectMembersQuery,
} from "@/web/api/project-members";
import { requireProjectRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ProjectMembersClient } from "./-components/project/project-members-client";

export const Route = createFileRoute("/$locale/_app/$projectKey/members")({
  // Managing members needs member:manage on this project; the scoped lookup
  // runs first so an invisible project 404s before any permission is checked.
  beforeLoad: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await requireProjectRole(queryClient, project.id, {
      member: ["manage"],
    });
  },
  loader: async ({ params: { projectKey }, context: { queryClient } }) => {
    const project = await queryClient.query(
      getProjectByKeyWithEnvironmentsQuery(projectKey)
    );
    if (!project) throw notFound();
    await Promise.all([
      loaderQuery(queryClient, listProjectMembersQuery(project.id)),
      loaderQuery(queryClient, listMemberCandidatesQuery(project.id)),
      loaderQuery(queryClient, listOrgWideAccessQuery(project.id)),
    ]);
  },
  pendingComponent: MembersPending,
  component: ProjectMembersPage,
});

function ProjectMembersPage() {
  const { projectKey } = Route.useParams();
  const t = useTranslations("projectOverview");
  const project = useSuspenseQuery(
    getProjectByKeyWithEnvironmentsQuery(projectKey)
  ).data;
  if (!project) throw notFound();
  const members = useSuspenseQuery(listProjectMembersQuery(project.id)).data;
  const memberCandidates = useSuspenseQuery(
    listMemberCandidatesQuery(project.id)
  ).data;
  const orgWideAccess = useSuspenseQuery(
    listOrgWideAccessQuery(project.id)
  ).data;

  return (
    <>
      <PageHeader title={t("members")} subtitle={project.name} />
      <ProjectMembersClient
        projectId={project.id}
        projectName={project.name}
        initialMembers={members}
        memberCandidates={memberCandidates}
        orgWideAccess={orgWideAccess}
      />
    </>
  );
}

function MembersPending() {
  return (
    <>
      <PageHeaderSkeleton withAction={false} />
      <Skeleton className="h-64 w-full rounded-lg" />
    </>
  );
}
