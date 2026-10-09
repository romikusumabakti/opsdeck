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
import { PageHeader } from "@/components/page-header";
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
import { canOrg } from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";

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
    listPersonOpenIssues(id),
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

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title={card.name} subtitle={card.title ?? undefined} />
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <UserAvatar user={card} size="xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{tRole(card.role)}</Badge>
              {card.deactivated && (
                <Badge variant="secondary">{t("deactivated")}</Badge>
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
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<a href={`mailto:${card.email}`} />}
              >
                <Mail />
                {card.email}
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
              <ul className="flex flex-col gap-2">
                {projects.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <Link
                      href={`/${p.key}`}
                      className="truncate hover:underline"
                    >
                      {p.name}
                    </Link>
                    <Badge variant="outline">{tProject(p.role)}</Badge>
                  </li>
                ))}
              </ul>
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
