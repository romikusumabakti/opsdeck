import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  Mail,
  MessageSquare,
  Pencil,
  Settings,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime, useRelativeTimeText } from "@/components/relative-time";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LocalTime } from "@/components/user/local-time";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link } from "@/i18n/navigation";
import { DATE_ONLY, DATE_TIME } from "@/lib/format-date";
import { qualifiedEnvName } from "@/lib/nav-path";
import { teamsChatUrl } from "@/lib/people/links";
import { canOrg, effectiveProjectRole } from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";
import { useMe } from "@/web/api/session";
import { getPersonQuery } from "@/web/api/users";
import { orNotFound } from "@/web/project-guard";

// Both side-by-side lists show this many rows (projects collapse behind
// "Show all", issues link to the filtered list) so the two cards stay level.
const LIST_ROWS = 8;

const RUN_STATUS_KEYS = {
  started: "statusRunning",
  success: "statusSuccess",
  failed: "statusFailed",
} as const;

export const Route = createFileRoute("/$locale/_app/people/$id")({
  beforeLoad: ({ params: { id } }) => {
    if (!uuidSchema.safeParse(id).success) throw notFound();
  },
  // The endpoint answers 404 for an unknown user and for one the caller may
  // not see (a deactivated account), as the page did.
  loader: async ({ params: { id }, context: { queryClient } }) => {
    await orNotFound(queryClient.query(getPersonQuery(id)));
  },
  pendingComponent: PersonPending,
  component: PersonPage,
});

function PersonPending() {
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeaderSkeleton withAction={false} />
      <div className="flex gap-4 rounded-xl border p-4">
        <Skeleton className="size-32 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}

function PersonPage() {
  const { id } = Route.useParams();
  const { card, projects, openIssues, runs, meta } = useSuspenseQuery(
    getPersonQuery(id)
  ).data;
  const me = useMe();
  const t = useTranslations("people");
  const tRole = useTranslations("users.role");
  const tProject = useTranslations("projectMembers.role");
  const tIssues = useTranslations("issues");
  const tHistory = useTranslations("history");
  const format = useFormatter();
  const relativeTimeText = useRelativeTimeText();
  const isMe = me?.user.id === id;
  const canManage = canOrg(me?.orgRole, { user: ["update"] });

  // A role badge on every project says nothing when the org role already
  // implies it (an admin is maintainer everywhere), so show only exceptions.
  const impliedRole = effectiveProjectRole(card.role, null);
  const shownProjects = projects.slice(0, LIST_ROWS);
  const moreProjects = projects.slice(LIST_ROWS);
  const projectItem = (p: (typeof projects)[number]) => (
    <li key={p.id} className="flex items-center justify-between gap-2">
      <Link href={`/${p.key}`} className="truncate hover:underline">
        {p.name}
      </Link>
      {p.role !== impliedRole && (
        <Badge variant="outline">{tProject(p.role)}</Badge>
      )}
    </li>
  );

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <UserAvatar user={card} size="xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {card.name}
                </h1>
                <Badge variant="outline">{tRole(card.role)}</Badge>
                {card.deactivated && (
                  <Badge variant="secondary">{t("deactivated")}</Badge>
                )}
              </div>
              {card.title && (
                <p className="text-muted-foreground">{card.title}</p>
              )}
            </div>
            {card.status && (
              <p>
                {card.status.emoji} {card.status.text}
                {card.status.expiresAt && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("until", {
                      date: format.dateTime(
                        new Date(card.status.expiresAt),
                        DATE_TIME
                      ),
                    })}
                  </span>
                )}
              </p>
            )}
            <div className="text-sm">
              <LocalTime
                timeZone={card.timeZone}
                workingHours={card.workingHours}
              />
            </div>
            {card.bio && (
              <p className="whitespace-pre-line text-sm">{card.bio}</p>
            )}
            {isMe && (!card.bio || !card.workingHours) && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {!card.bio && (
                  <Link
                    href="/account?tab=profile"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {t("addBio")}
                  </Link>
                )}
                {!card.workingHours && (
                  <Link
                    href="/account?tab=profile"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {t("setWorkingHours")}
                  </Link>
                )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("memberSince", {
                date: format.dateTime(new Date(meta.createdAt), DATE_ONLY),
              })}
              {" · "}
              {meta.lastActiveAt ? (
                <span
                  title={format.dateTime(
                    new Date(meta.lastActiveAt),
                    DATE_TIME
                  )}
                >
                  {t("lastActive", {
                    ago: relativeTimeText(meta.lastActiveAt),
                  })}
                </span>
              ) : (
                t("neverActive")
              )}
            </p>
            <p className="flex items-center gap-1 text-sm text-muted-foreground">
              <span className="truncate">{card.email}</span>
              <CopyButton value={card.email} label={t("copyEmail")} />
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<a href={`mailto:${card.email}`} />}
              >
                <Mail />
                {t("email")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={teamsChatUrl(card.email)}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                <MessageSquare />
                {t("teams")}
              </Button>
              {card.jiraUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  nativeButton={false}
                  render={
                    <a href={card.jiraUrl} target="_blank" rel="noreferrer" />
                  }
                >
                  <SquareArrowOutUpRight />
                  {t("jira")}
                </Button>
              )}
              {isMe && (
                <Button
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/account?tab=profile" />}
                >
                  <Pencil />
                  {t("editProfile")}
                </Button>
              )}
              {canManage && !isMe && (
                <Button
                  size="sm"
                  variant="ghost"
                  nativeButton={false}
                  render={<Link href="/admin/users" />}
                >
                  <Settings />
                  {t("manage")}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("projects")}</CardTitle>
          </CardHeader>
          <CardContent>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("noSharedProjects")}
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-2 text-sm">
                  {shownProjects.map(projectItem)}
                </ul>
                {moreProjects.length > 0 && (
                  <details className="group mt-2">
                    <summary className="cursor-pointer list-none text-sm underline underline-offset-2 group-open:hidden">
                      {t("showAllProjects", { count: projects.length })}
                    </summary>
                    <ul className="flex flex-col gap-2 text-sm">
                      {moreProjects.map(projectItem)}
                    </ul>
                  </details>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              {t("openIssues", { count: openIssues.total })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {openIssues.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("noOpenIssues")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {openIssues.items.map((i) => (
                  <li key={i.id} className="flex items-center gap-2 text-sm">
                    <Link
                      href={`/${i.projectKey}/issues/${i.number}`}
                      className="font-mono text-muted-foreground hover:underline"
                    >
                      {i.projectKey}-{i.number}
                    </Link>
                    <span className="truncate">{i.title}</span>
                    <Badge variant="secondary" className="ms-auto shrink-0">
                      {tIssues(`status.${i.status}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            {openIssues.total > openIssues.items.length && (
              <Link
                href={`/issues?assignee=${id}`}
                className="text-sm underline underline-offset-2"
              >
                {t("viewAllIssues")}
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("recentRuns")}</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noRuns")}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Badge
                    variant={
                      r.status === "failed" ? "destructive" : "secondary"
                    }
                  >
                    {tHistory(
                      RUN_STATUS_KEYS[
                        r.status as keyof typeof RUN_STATUS_KEYS
                      ] ?? "statusRunning"
                    )}
                  </Badge>
                  <Link
                    href={`/${r.environment.project.key}/${r.environment.slug}/history`}
                    className="truncate hover:underline"
                  >
                    {qualifiedEnvName(
                      r.environment.name,
                      r.environment.project.name
                    )}{" "}
                    · {r.description}
                  </Link>
                  <span className="ms-auto shrink-0 text-muted-foreground">
                    <RelativeTime date={r.runAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
