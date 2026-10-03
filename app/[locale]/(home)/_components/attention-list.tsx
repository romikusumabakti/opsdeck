"use client";

import { formatDistanceToNow } from "date-fns";
import { Check, CircleAlert, FilePlus2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { acknowledgeAttentionGroup, unacknowledgeRuns } from "@/actions/home";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { failurePrefill } from "@/lib/home/attention";
import type { AttentionGroup } from "@/lib/home/queries";
import { useIssueDialog } from "./home-issue-dialog";

const groupId = (g: AttentionGroup) => `${g.environmentId}\u0000${g.key}`;
const KINDS = ["backup", "restore", "mock_time", "test"] as const;

export function AttentionList({ groups }: { groups: AttentionGroup[] }) {
  const t = useTranslations("homePage");
  const locale = useLocale();
  const dfl = getDateFnsLocale(locale);
  const issueDialog = useIssueDialog();
  const [, startTransition] = React.useTransition();
  // The acknowledged row disappears at once; the action's revalidation brings
  // the fresh list that no longer contains it.
  const [visible, hide] = React.useOptimistic(groups, (cur, id: string) =>
    cur.filter((g) => groupId(g) !== id)
  );

  const kindLabel = (g: AttentionGroup) =>
    (KINDS as readonly string[]).includes(g.latest.kind ?? "")
      ? t(`kind.${g.latest.kind as (typeof KINDS)[number]}`)
      : g.latest.description;

  function undo(g: AttentionGroup, runIds: string[]) {
    startTransition(async () => {
      const res = await unacknowledgeRuns(g.environmentId, runIds);
      if (!res.success) toast.error(t("attention.undoFailed"));
    });
  }

  function acknowledge(g: AttentionGroup) {
    startTransition(async () => {
      hide(groupId(g));
      const res = await acknowledgeAttentionGroup(g.environmentId, g.key);
      if (!res.success) {
        toast.error(t("attention.ackFailed"));
        return;
      }
      toast.success(t("attention.acknowledged"), {
        action: {
          label: t("attention.undo"),
          onClick: () => undo(g, res.data.runIds),
        },
      });
    });
  }

  function createIssue(g: AttentionGroup) {
    issueDialog.open({
      projectId: g.projectId,
      environmentId: g.environmentId,
      ...failurePrefill(
        g,
        t("attention.issueTitle", {
          kind: kindLabel(g),
          environment: g.environmentName,
        }),
        t("attention.runHistory")
      ),
    });
  }

  return (
    <ul className="flex flex-col divide-y">
      {visible.map((g) => (
        <li
          key={groupId(g)}
          className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors"
        >
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
          <Link
            href={`${g.envPath}/history`}
            title={g.latest.errorMessage ?? g.latest.description}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span className="truncate text-sm">
              {kindLabel(g)} · {g.environmentName}
            </span>
            {g.count > 1 ? (
              <Badge variant="destructive" className="shrink-0 tabular-nums">
                ×{g.count}
              </Badge>
            ) : null}
          </Link>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {formatDistanceToNow(new Date(g.latest.runAt), {
              addSuffix: true,
              locale: dfl,
            })}
          </span>
          {issueDialog.canCreateIn(g.projectId) ? (
            <Button variant="ghost" size="xs" onClick={() => createIssue(g)}>
              <FilePlus2 />
              {t("attention.createIssue")}
            </Button>
          ) : null}
          {g.canAcknowledge ? (
            <Button variant="ghost" size="xs" onClick={() => acknowledge(g)}>
              <Check />
              {t("attention.acknowledge")}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
