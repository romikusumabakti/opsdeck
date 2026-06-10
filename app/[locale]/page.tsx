import { formatDistanceToNow, type Locale } from "date-fns";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  Plus,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { getProjects } from "@/actions/projects";
import { getProjectsLastActivity, type ProjectActivity } from "@/actions/tasks";
import { PageHeader } from "@/components/page-header";
import { ProjectsEmpty } from "@/components/projects-empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

export default async function Home() {
  const [projects, session, lastActivity, locale] = await Promise.all([
    getProjects(),
    getServerSession(),
    getProjectsLastActivity(),
    getLocale(),
  ]);
  const admin = session ? isAdmin(session) : false;

  if (projects.length === 0) {
    return <ProjectsEmpty canCreate={admin} />;
  }

  const t = await getTranslations("home");
  const tDash = await getTranslations("dashboard");
  const dateFnsLocale = getDateFnsLocale(locale);

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => {
          const activity = lastActivity[project.id] ?? null;
          return (
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
                      <span className="font-medium truncate">
                        {project.name}
                      </span>
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
                  <ActivityRow
                    activity={activity}
                    dateFnsLocale={dateFnsLocale}
                    neverText={t("neverActive")}
                  />
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </>
  );
}

function ActivityRow({
  activity,
  dateFnsLocale,
  neverText,
}: {
  activity: ProjectActivity | null;
  dateFnsLocale: Locale | undefined;
  neverText: string;
}) {
  if (!activity) {
    return (
      <span className="text-xs text-muted-foreground italic">{neverText}</span>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
      <StatusDot status={activity.status} />
      <span className="truncate">
        {formatDistanceToNow(new Date(activity.runAt), {
          addSuffix: true,
          locale: dateFnsLocale,
        })}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: ProjectActivity["status"] }) {
  if (status === "started") {
    return <Loader2 className="size-3 text-primary animate-spin shrink-0" />;
  }
  if (status === "failed") {
    return <CircleAlert className="size-3 text-destructive shrink-0" />;
  }
  return <CheckCircle2 className="size-3 text-success shrink-0" />;
}
