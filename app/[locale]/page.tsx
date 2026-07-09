import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getProjects, getProjectsLastOpened } from "@/actions/projects";
import { getProjectsLastActivity } from "@/actions/runs";
import { PageHeader } from "@/components/page-header";
import { ProjectsEmpty } from "@/components/projects-empty";
import type { SortKey } from "@/components/projects-grid";
import { ProjectsGrid } from "@/components/projects-grid";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getServerSession, isAdmin } from "@/lib/auth-session";

const SORT_KEYS: SortKey[] = ["recent", "opened", "name_asc", "name_desc"];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const [{ sort }, projects, session, lastActivity, lastOpened] =
    await Promise.all([
      searchParams,
      getProjects(),
      getServerSession(),
      getProjectsLastActivity(),
      getProjectsLastOpened(),
    ]);
  const admin = session ? isAdmin(session) : false;
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
            <Button render={<Link href="/projects/new" />}>
              <Plus className="size-4" />
              {t("create")}
            </Button>
          ) : undefined
        }
      />
      <ProjectsGrid
        projects={projects}
        lastActivity={lastActivity}
        lastOpened={lastOpened}
        initialSort={initialSort}
      />
    </>
  );
}
