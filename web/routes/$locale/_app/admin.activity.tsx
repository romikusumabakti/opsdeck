import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { UserAvatar } from "@/components/user/user-avatar";
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

const VARIABLE_MESSAGES = {
  "variable.created": "variableCreated",
  "variable.updated": "variableUpdated",
  "variable.deleted": "variableDeleted",
  "variable.regenerated": "variableRegenerated",
  "variable.escrowRemoved": "variableEscrowRemoved",
} as const;

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
      // Rows written before memberships lost their role still name it.
      return d.role
        ? t("memberAdded", {
            actor,
            user: String(d.user),
            project: String(d.project),
            role: String(d.role),
          })
        : t("memberAddedToProject", {
            actor,
            user: String(d.user),
            project: String(d.project),
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
    case "project.defaultServerChanged":
      return d.server
        ? t("projectDefaultServerSet", {
            actor,
            project: String(d.project),
            server: String(d.server),
          })
        : t("projectDefaultServerCleared", {
            actor,
            project: String(d.project),
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
    case "cloudflare_account.update":
      return t("cloudflareAccountUpdated", {
        actor,
        fields: String(d.fields),
      });
    case "environment.domain.update":
      return t("environmentDomainUpdated", {
        actor,
        environment: String(d.environment),
        hostname: String(d.hostname),
      });
    case "environment.domain.adopted":
      return t("environmentDomainAdopted", {
        actor,
        environment: String(d.environment),
        hostname: String(d.hostname),
      });
    case "environment.domain.delete":
      return t("environmentDomainDeleted", {
        actor,
        environment: String(d.environment),
        hostname: String(d.hostname),
      });
    case "mailpit.configured":
      return t("mailpitConfigured", {
        actor,
        environment: String(d.environment),
      });
    case "variables.revealed":
      return t("variablesRevealed", {
        actor,
        names: String(d.names) || "—",
        environment: String(d.environment),
      });
    case "variable.created":
    case "variable.updated":
    case "variable.deleted":
    case "variable.regenerated":
    case "variable.escrowRemoved":
      return t(VARIABLE_MESSAGES[row.action], {
        actor,
        name: String(d.name),
        environment: String(d.environment),
      });
    case "variables.envFileManagedOn":
      return t("envFileManagedOn", {
        actor,
        environment: String(d.environment),
      });
    case "variables.envFileManagedOff":
      return t("envFileManagedOff", {
        actor,
        environment: String(d.environment),
      });
    case "variables.templateApplied":
      return t("variablesTemplateApplied", {
        actor,
        names: String(d.names),
        environment: String(d.environment),
      });
    case "variableTemplate.saved":
      return t("variableTemplateSaved", {
        actor,
        name: String(d.name),
        app: String(d.app),
      });
    case "variableTemplate.deleted":
      return t("variableTemplateDeleted", {
        actor,
        name: String(d.name),
        app: String(d.app),
      });
    case "environment.deletedWithVariables":
      return t("environmentDeletedWithVariables", {
        actor,
        environment: String(d.environment),
        count: Number(d.count),
        names: String(d.names) || "—",
      });
    case "environment.deleted":
      return t("environmentDeleted", {
        actor,
        environment: String(d.environment),
      });
    case "environment.provision":
      return t("environmentProvisioned", {
        actor,
        environment: String(d.environment),
      });
    case "environment.setup":
      return t("environmentSetup", {
        actor,
        environment: String(d.environment),
      });
    case "app.build.trigger":
      return t("appBuildTriggered", {
        actor,
        component: String(d.component),
        branch: String(d.branch),
      });
    case "deployLock.locked":
      return t("deployLockLocked", {
        actor,
        environment: String(d.environment),
        reason: String(d.reason),
      });
    case "deployLock.updated":
      return t("deployLockUpdated", {
        actor,
        environment: String(d.environment),
        reason: String(d.reason),
      });
    case "deployLock.unlocked":
      return t("deployLockUnlocked", {
        actor,
        environment: String(d.environment),
        count: Number(d.count),
      });
    case "deployLock.forceUnlocked":
      return t("deployLockForceUnlocked", {
        actor,
        environment: String(d.environment),
        reason: String(d.reason),
        count: Number(d.count),
      });
    case "deployLock.expired":
      return t("deployLockExpired", {
        environment: String(d.environment),
        count: Number(d.count),
      });
    case "deployTarget.created":
      return t("deployTargetCreated", {
        actor,
        component: String(d.component),
        environment: String(d.environment),
      });
    case "deployTarget.updated":
      // `changes` lists each changed field (`name: old → new`, or
      // `name: changed` for the server and the pre-start command).
      return t("deployTargetUpdated", {
        actor,
        component: String(d.component),
        environment: String(d.environment),
        changes: String(d.changes),
      });
    case "deployTarget.deleted":
      return t("deployTargetDeleted", {
        actor,
        component: String(d.component),
        environment: String(d.environment),
      });
    case "release.created":
      return t("releaseCreated", {
        actor,
        project: String(d.project),
        component: String(d.component),
        version: String(d.version),
      });
    case "release.downloaded":
      return t("releaseDownloaded", {
        actor,
        project: String(d.project),
        component: String(d.component),
        version: String(d.version),
      });
    case "release.deleted":
      return t("releaseDeleted", {
        actor,
        project: String(d.project),
        component: String(d.component),
        version: String(d.version),
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
    case "server.preflight":
      return t("serverPreflight", { actor, server: String(d.server) });
    // Pinned by whichever connection reached the server first. A job has no
    // actor, so that sentence is about the server.
    case "server.hostKeyPinned":
      return row.actorName
        ? t("serverHostKeyPinnedBy", {
            actor,
            server: String(d.server),
            fingerprint: String(d.fingerprint),
          })
        : t("serverHostKeyPinned", {
            server: String(d.server),
            fingerprint: String(d.fingerprint),
          });
    case "server.hostKeyMismatch":
      return t("serverHostKeyMismatch", {
        server: String(d.server),
        fingerprint: String(d.fingerprint),
        pinned: String(d.pinned),
      });
    case "server.hostKeyTrusted":
      return t("serverHostKeyTrusted", {
        actor,
        server: String(d.server),
        fingerprint: String(d.fingerprint),
      });
    case "server.keyInstalled":
      return t("serverKeyInstalled", {
        actor,
        server: String(d.server),
        from: String(d.from),
      });
    case "server.keyReinstalled":
      return t("serverKeyReinstalled", {
        actor,
        server: String(d.server),
        from: String(d.from),
      });
    case "server.keyFromChanged":
      return t("serverKeyFromChanged", {
        actor,
        server: String(d.server),
        before: String(d.before || "—"),
        after: String(d.after),
      });
    case "server.keyRotated":
      return t("serverKeyRotated", {
        actor,
        server: String(d.server),
        from: String(d.from),
      });
    case "database_host.create":
      return t("databaseHostCreated", {
        actor,
        label: String(d.label),
        container: String(d.container),
        server: String(d.server),
      });
    case "database_host.update":
      return t("databaseHostUpdated", {
        actor,
        label: String(d.label),
        container: String(d.container),
        server: String(d.server),
        network: d.network ? String(d.network) : "-",
      });
    case "database_host.delete":
      return t("databaseHostDeleted", {
        actor,
        label: String(d.label),
        container: String(d.container),
        server: String(d.server),
      });
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
    // File explorer events. `path` is "" for the root; a selection carries its
    // first path and a `count`.
    case "files.read":
    case "files.save":
    case "files.createFolder":
    case "files.delete":
    case "files.upload":
    case "files.rename":
    case "files.move":
    case "files.copy":
    case "files.compress":
    case "files.download": {
      const verb = row.action.slice("files.".length);
      const params = {
        actor,
        target: String(d.target),
        path: String(d.path || "/"),
        to: String(d.to ?? ""),
        archive: String(d.archive ?? ""),
        count: Number(d.count ?? 1),
      };
      return t(`files.${verb}${params.count > 1 ? "Many" : ""}`, params);
    }
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
  const t = useTranslations("activity");
  const tIssues = useTranslations("issues");
  const events = useSuspenseQuery(listActivityQuery(FEED_LIMIT)).data;

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
                <RelativeTime date={e.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
