import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Activity } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user/user-avatar";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { type listActivity, listActivityQuery } from "@/web/api/activity";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { ActivityPending } from "./-components/admin/activity-pending";

type ActivityRow = Awaited<ReturnType<typeof listActivity>>[number];

// The feed shows the latest 100 events.
const FEED_LIMIT = 100;

export const Route = createFileRoute("/$locale/_app/admin/activity")({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { audit: ["read"] });
  },
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listActivityQuery(FEED_LIMIT));
  },
  pendingComponent: ActivityPending,
  component: ActivityPage,
});

// Render one event to a localized sentence. `data` is the denormalized params
// snapshotted at write time (see lib/activity.ts).
function message(
  t: ReturnType<typeof useTranslations<"activity">>,
  tIssues: ReturnType<typeof useTranslations<"issues">>,
  row: ActivityRow
): string {
  const actor = row.actorName ?? t("someone");
  const d = row.data;
  switch (row.action) {
    case "issue.created":
      return t("issueCreated", { actor, key: String(d.key) });
    case "issue.status_changed":
      return t("issueStatusChanged", {
        actor,
        key: String(d.key),
        status: tIssues(`status.${d.status}`),
      });
    case "member.added":
      return t("memberAdded", {
        actor,
        user: String(d.user),
        project: String(d.project),
        role: String(d.role),
      });
    case "member.removed":
      return t("memberRemoved", {
        actor,
        user: String(d.user),
        project: String(d.project),
      });
    case "member.roleChanged":
      return t("memberRoleChanged", {
        actor,
        user: String(d.user),
        project: String(d.project),
        from: String(d.from),
        to: String(d.to),
      });
    case "user.offboarded":
      return t("userOffboarded", { actor, user: String(d.user) });
    case "user.roleChanged":
      return t("userRoleChanged", {
        actor,
        user: String(d.user),
        from: String(d.from),
        to: String(d.to),
      });
    case "user.invited":
      return t("userInvited", {
        actor,
        email: String(d.email),
        role: String(d.role),
      });
    case "profile.updated":
      return t("profileUpdated", { actor, user: String(d.user) });
    case "user.deleted":
      return t("userDeleted", { actor, user: String(d.user) });
    case "user.invitationRevoked":
      return t("userInvitationRevoked", { actor, email: String(d.email) });
    case "user.invitationResent":
      return t("userInvitationResent", { actor, email: String(d.email) });
    case "milestone.created":
      return t("milestoneCreated", { actor, name: String(d.name) });
    case "tunnel.route.created":
      return t("tunnelRouteCreated", {
        actor,
        hostname: String(d.hostname),
        origin: String(d.origin),
      });
    case "tunnel.route.deleted":
      return t("tunnelRouteDeleted", { actor, hostname: String(d.hostname) });
    case "tunnel.network.attached":
      return t("tunnelNetworkAttached", {
        actor,
        network: String(d.network),
        tunnel: String(d.tunnel),
      });
    case "mailpit.configured":
      return t("mailpitConfigured", {
        actor,
        environment: String(d.environment),
      });
    case "mailpit.removed":
      return t("mailpitRemoved", { actor, environment: String(d.environment) });
    case "mail.deleted":
      return t("mailDeleted", {
        actor,
        count: Number(d.count),
        environment: String(d.environment),
      });
    case "mail.deleted_search":
      return t("mailDeletedSearch", {
        actor,
        query: String(d.query),
        environment: String(d.environment),
      });
    case "mail.cleared":
      return t("mailCleared", { actor, environment: String(d.environment) });
    case "terminal.open":
      return t("terminalOpened", { actor, server: String(d.server) });
    case "terminal.close":
      return t("terminalClosed", {
        actor,
        server: String(d.server),
        seconds: String(d.seconds),
      });
    case "terminal.denied":
      // A denial from an unverifiable ticket names no server — there is no
      // trustworthy id to attribute it to (see lib/terminal/server.ts).
      return d.server
        ? t("terminalDenied", {
            actor,
            server: String(d.server),
            reason: String(d.reason),
          })
        : t("terminalDeniedUnknownServer", {
            actor,
            reason: String(d.reason),
          });
    // Jira sync events have no actor — they are written by the worker, so the
    // sentence is about the issue rather than a person.
    case "issue.jira_conflict":
      return t("issueJiraConflict", {
        key: String(d.key),
        fields: String(d.fields),
      });
    case "issue.jira_push_failed":
      return t("issueJiraPushFailed", { field: String(d.field) });
    case "test.recorded":
      return t("testRecorded", {
        actor,
        key: String(d.key),
        result: t(`result.${d.result}` as "result.pass" | "result.fail"),
      });
    case "run.acknowledged":
      return t("runAcknowledged", {
        actor,
        count: Number(d.count),
        environment: String(d.environment),
      });
    case "run.unacknowledged":
      return t("runUnacknowledged", {
        actor,
        count: Number(d.count),
        environment: String(d.environment),
      });
    default:
      return t("unknown", { actor });
  }
}

function ActivityPage() {
  const locale = useLocale();
  const t = useTranslations("activity");
  const tIssues = useTranslations("issues");
  const events = useSuspenseQuery(listActivityQuery(FEED_LIMIT)).data;
  const dfl = getDateFnsLocale(locale);

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <Activity className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-3 px-3 py-2.5 text-sm"
            >
              {e.actorId && e.actorName ? (
                <UserAvatar
                  user={{
                    id: e.actorId,
                    name: e.actorName,
                    image: e.actorImage,
                  }}
                  size="sm"
                />
              ) : (
                <Activity className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 min-w-0">{message(t, tIssues, e)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(e.createdAt), {
                  addSuffix: true,
                  locale: dfl,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
