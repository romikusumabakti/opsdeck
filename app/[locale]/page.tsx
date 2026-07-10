import { formatDistanceToNow } from "date-fns";
import {
  ChevronRight,
  CircleAlert,
  CircleDot,
  Loader2,
  ServerCog,
} from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { listAssignedIssues } from "@/actions/issues";
import { listProjects } from "@/actions/project-catalog";
import { getProjects } from "@/actions/projects";
import { getActiveRuns, getRecentFailedRuns } from "@/actions/runs";
import { STATUS_DOT, type Status } from "@/components/issues-board";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { cn } from "@/lib/utils";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();

  const [assigned, activeRuns, failedRuns, recentEnvs, logicalProjects, t] =
    await Promise.all([
      listAssignedIssues(session.user.id),
      getActiveRuns(),
      getRecentFailedRuns(6),
      getProjects(),
      listProjects(),
      getTranslations("inbox"),
    ]);
  const dfl = getDateFnsLocale(locale);
  const projectNameById: Record<string, string> = Object.fromEntries(
    logicalProjects.map((p) => [p.id, p.name])
  );
  const ago = (d: Date) =>
    formatDistanceToNow(new Date(d), { addSuffix: true, locale: dfl });

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Assigned to me */}
        <Section
          icon={<CircleDot className="size-4" />}
          title={t("assignedToMe")}
        >
          {assigned.length === 0 ? (
            <Empty text={t("assignedEmpty")} />
          ) : (
            <ul className="flex flex-col divide-y">
              {assigned.map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/project/${i.project.key}`}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors"
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full shrink-0",
                        STATUS_DOT[i.status as Status]
                      )}
                    />
                    <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                      {i.project.key}-{i.number}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {i.title}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                      {i.project.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Running now */}
        <Section icon={<Loader2 className="size-4" />} title={t("runningNow")}>
          {activeRuns.length === 0 ? (
            <Empty text={t("runningEmpty")} />
          ) : (
            <ul className="flex flex-col divide-y">
              {activeRuns.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/projects/${r.projectId}/history`}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors"
                  >
                    <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {r.description}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-[40%]">
                      {r.project?.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Needs attention (recent failures) */}
        <Section
          icon={<CircleAlert className="size-4 text-destructive" />}
          title={t("needsAttention")}
        >
          {failedRuns.length === 0 ? (
            <Empty text={t("failedEmpty")} />
          ) : (
            <ul className="flex flex-col divide-y">
              {failedRuns.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/projects/${r.environmentId}/history`}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors"
                  >
                    <CircleAlert className="size-3.5 text-destructive shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {r.description}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {ago(r.runAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Jump back in (recent environments) */}
        <Section
          icon={<ServerCog className="size-4" />}
          title={t("jumpBackIn")}
        >
          {recentEnvs.length === 0 ? (
            <Empty text={t("recentEmpty")} />
          ) : (
            <ul className="flex flex-col divide-y">
              {recentEnvs.slice(0, 6).map((env) => (
                <li key={env.id}>
                  <Link
                    href={`/projects/${env.id}`}
                    className="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors group"
                  >
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {env.name}
                    </span>
                    {env.kind ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase shrink-0"
                      >
                        {env.kind}
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                      {projectNameById[env.projectId]}
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="py-0 overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b text-sm font-medium">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="px-3 py-8 text-center text-sm text-muted-foreground">
      {text}
    </p>
  );
}
