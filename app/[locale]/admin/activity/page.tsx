import { formatDistanceToNow } from "date-fns";
import { Activity } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { type ActivityRow, listActivity } from "@/actions/activity";
import { PageHeader } from "@/components/page-header";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

// Render one event to a localized sentence. `data` is the denormalized params
// snapshotted at write time (see lib/activity.ts).
function message(
  t: Awaited<ReturnType<typeof getTranslations<"activity">>>,
  tIssues: Awaited<ReturnType<typeof getTranslations<"issues">>>,
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
    case "milestone.created":
      return t("milestoneCreated", { actor, name: String(d.name) });
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
    default:
      return t("unknown", { actor });
  }
}

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [events, t, tIssues] = await Promise.all([
    listActivity(100),
    getTranslations("activity"),
    getTranslations("issues"),
  ]);
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
              <Activity className="size-4 shrink-0 text-muted-foreground" />
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
