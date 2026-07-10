import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getOpenIssueCounts } from "@/actions/issues";
import { listProjects } from "@/actions/project-catalog";
import { getProjects, getProjectsLastOpened } from "@/actions/projects";
import { getProjectsLastActivity } from "@/actions/runs";
import { NewProjectButton } from "@/components/new-project-button";
import { PageHeader } from "@/components/page-header";
import { ProjectsEmpty } from "@/components/projects-empty";
import type { SortKey } from "@/components/projects-grid";
import { ProjectsGrid } from "@/components/projects-grid";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getServerSession, isAdmin } from "@/lib/auth-session";

const SORT_KEYS: SortKey[] = ["recent", "opened", "name_asc", "name_desc"];

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const [
    { sort },
    projects,
    logicalProjects,
    session,
    lastActivity,
    lastOpened,
    openIssueCounts,
  ] = await Promise.all([
    searchParams,
    getProjects(),
    listProjects(),
    getServerSession(),
    getProjectsLastActivity(),
    getProjectsLastOpened(),
    getOpenIssueCounts(),
  ]);
  const admin = session ? isAdmin(session) : false;
  const projectNameById: Record<string, string> = Object.fromEntries(
    logicalProjects.map((p) => [p.id, p.name])
  );
  const projectKeyById: Record<string, string> = Object.fromEntries(
    logicalProjects.map((p) => [p.id, p.key])
  );
  const initialSort: SortKey = SORT_KEYS.includes(sort as SortKey)
    ? (sort as SortKey)
    : "recent";

  if (projects.length === 0) {
    return <ProjectsEmpty canCreate={admin} />;
  }

  const t = await getTranslations("home");

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          admin ? (
            <div className="flex gap-2">
              <NewProjectButton />
              <Button render={<Link href="/projects/new" />}>
                <Plus className="size-4" />
                {t("newEnvironment")}
              </Button>
            </div>
          ) : undefined
        }
      />
      <ProjectsGrid
        projects={projects}
        projectNameById={projectNameById}
        projectKeyById={projectKeyById}
        openIssueCounts={openIssueCounts}
        lastActivity={lastActivity}
        lastOpened={lastOpened}
        initialSort={initialSort}
      />
    </>
  );
}
