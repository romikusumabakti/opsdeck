import { getTranslations } from "next-intl/server";
import { getEnvironmentsLastOpened } from "@/actions/environments";
import { getOpenIssueCounts } from "@/actions/issues";
import { listProjectsWithEnvironments } from "@/actions/project-catalog";
import { getEnvironmentsLastActivity } from "@/actions/runs";
import { NewProjectButton } from "@/components/new-project-button";
import { PageHeader } from "@/components/page-header";
import { ProjectsEmpty } from "@/components/projects-empty";
import type { SortKey } from "@/components/projects-overview";
import { ProjectsOverview } from "@/components/projects-overview";
import { getOrgRole, getProjectAccess } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";

const SORT_KEYS: SortKey[] = ["recent", "opened", "name_asc", "name_desc"];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const [
    { sort },
    projects,
    orgRole,
    access,
    lastActivity,
    lastOpened,
    openIssueCounts,
  ] = await Promise.all([
    searchParams,
    listProjectsWithEnvironments(),
    getOrgRole(),
    getProjectAccess(),
    getEnvironmentsLastActivity(),
    getEnvironmentsLastOpened(),
    getOpenIssueCounts(),
  ]);
  // The list is every member's; only the create affordances depend on the role.
  const canCreateProject = canOrg(orgRole, { project: ["create"] });
  const initialSort: SortKey = SORT_KEYS.includes(sort as SortKey)
    ? (sort as SortKey)
    : "recent";

  if (projects.length === 0) {
    return <ProjectsEmpty canCreate={canCreateProject} />;
  }

  const t = await getTranslations("home");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        // Only "New project" here: an environment always belongs to a project,
        // so it is created from that project's card (which prefills the parent).
        action={canCreateProject ? <NewProjectButton /> : undefined}
      />
      <ProjectsOverview
        projects={projects}
        openIssueCounts={openIssueCounts}
        lastActivity={lastActivity}
        lastOpened={lastOpened}
        initialSort={initialSort}
        projectRoles={access.roles}
      />
    </>
  );
}
