import { ChevronRight, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getProjects } from "@/actions/projects";
import { ProjectsEmpty } from "@/components/projects-empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";

export default async function Home() {
  const projects = await getProjects();

  if (projects.length === 0) {
    return <ProjectsEmpty />;
  }

  const t = await getTranslations("home");
  const tDash = await getTranslations("dashboard");

  return (
    <div className="max-w-5xl py-8 mx-auto w-full px-4">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus className="size-4" />
            {t("create")}
          </Link>
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <Link
            key={project.id}
            href={`/projects/${project.id}`}
            className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
          >
            <Card className="h-full hover:border-primary/50 hover:shadow-sm transition-all">
              <CardContent className="p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="size-9 rounded-md bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">
                      {project.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="font-medium truncate">{project.name}</span>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
                </div>
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {tDash(`dbTypes.${project.dbType}`)}
                  </Badge>
                  <code className="font-mono text-xs text-muted-foreground truncate">
                    {project.dbName}
                  </code>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
