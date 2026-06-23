import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getProjects } from "@/actions/projects";
import { getProjectsLastActivity } from "@/actions/tasks";
import { PageHeader } from "@/components/page-header";
import { ProjectsEmpty } from "@/components/projects-empty";
import { ProjectsGrid } from "@/components/projects-grid";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getServerSession, isAdmin } from "@/lib/auth-session";

export default async function Home() {
  const [projects, session, lastActivity] = await Promise.all([
    getProjects(),
    getServerSession(),
    getProjectsLastActivity(),
  ]);
  const admin = session ? isAdmin(session) : false;

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
            <Button asChild>
              <Link href="/projects/new">
                <Plus className="size-4" />
                {t("create")}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <ProjectsGrid projects={projects} lastActivity={lastActivity} />
    </>
  );
}
