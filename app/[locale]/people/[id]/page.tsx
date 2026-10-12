import { formatDistanceToNow } from "date-fns";
import {
  Mail,
  MessageSquare,
  Pencil,
  Settings,
  SquareArrowOutUpRight,
} from "lucide-react";
import { notFound } from "next/navigation";
import {
  getFormatter,
  getLocale,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalTime } from "@/components/user/local-time";
import { UserAvatar } from "@/components/user/user-avatar";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { getUserCard } from "@/lib/people/card";
import { teamsChatUrl } from "@/lib/people/links";
import {
  getPersonMeta,
  getPersonProjects,
  listPersonOpenIssues,
  listPersonRecentRuns,
} from "@/lib/people/queries";
import { canOrg, effectiveProjectRole } from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";

// Both side-by-side lists show this many rows (projects collapse behind
// "Show all", issues link to the filtered list) so the two cards stay level.
const LIST_ROWS = 8;

const RUN_STATUS_KEYS = {
  started: "statusRunning",
  success: "statusSuccess",
  failed: "statusFailed",
} as const;

export default async function PersonPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!uuidSchema.safeParse(id).success) notFound();
  const session = await requireSession();
  const card = await getUserCard(id, session.user);
  if (!card) notFound();

  const [
    projects,
    openIssues,
    runs,
    meta,
    t,
    tRole,
    tProject,
    tIssues,
    tHistory,
    format,
  ] = await Promise.all([
    getPersonProjects(id),
    listPersonOpenIssues(id, LIST_ROWS),
    listPersonRecentRuns(id),
    getPersonMeta(id),
    getTranslations("people"),
    getTranslations("users.role"),
    getTranslations("projectMembers.role"),
    getTranslations("issues"),
    getTranslations("history"),
    getFormatter(),
  ]);
  const dfLocale = getDateFnsLocale(await getLocale());
  const isMe = session.user.id === id;
  const canManage = canOrg(session.user.role, { user: ["update"] });

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
                      date: format.dateTime(new Date(card.status.expiresAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </span>
                )}
              </p>
            )}
            <p className="text-sm">
              <LocalTime
                timeZone={card.timeZone}
                workingHours={card.workingHours}
              />
            </p>
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
                date: format.dateTime(meta.createdAt, { dateStyle: "medium" }),
              })}
              {" · "}
              {meta.lastActiveAt
                ? t("lastActive", {
                    ago: formatDistanceToNow(meta.lastActiveAt, {
                      addSuffix: true,
                      locale: dfLocale,
                    }),
                  })
                : t("neverActive")}
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
                    {r.environment.name} · {r.description}
                  </Link>
                  <span className="ms-auto shrink-0 text-muted-foreground">
                    {formatDistanceToNow(r.runAt, {
                      addSuffix: true,
                      locale: dfLocale,
                    })}
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
