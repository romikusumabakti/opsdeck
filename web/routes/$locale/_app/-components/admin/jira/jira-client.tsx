import { Cable, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TooltipHint } from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import {
  deleteJiraConnection,
  type JiraConnectionRow as SafeJiraConnection,
} from "@/web/api/jira";

export function JiraClient({
  connections,
}: {
  connections: SafeJiraConnection[];
}) {
  const t = useTranslations("jira");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  const [optimistic, removeOptimistic] = useOptimistic<
    SafeJiraConnection[],
    string[]
  >(connections, (state, ids) => state.filter((c) => !ids.includes(c.id)));

  const onDelete = React.useCallback(
    async (conn: SafeJiraConnection) => {
      const ok = await dialog.confirmTyping({
        title: t("deleteTitle"),
        description: t("deleteDescription", { name: conn.name }),
        phrase: conn.name,
        phraseLabel: tCommon("confirmTypingLabel"),
        placeholder: tCommon("confirmTypingPlaceholder"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        removeOptimistic([conn.id]);
        const result = await deleteJiraConnection(conn.id);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message ?? "");
      });
    },
    [dialog, t, tCommon, removeOptimistic]
  );

  if (optimistic.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState
          icon={Cable}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button
              nativeButton={false}
              render={<Link href="/admin/jira/new" />}
            >
              <Plus className="size-4" />
              {t("addConnection")}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-4xl w-full">
      {optimistic.map((conn) => (
        <Card key={conn.id}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cable className="size-4 text-muted-foreground" />
              {conn.name}
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{conn.baseUrl}</span>
              <Badge variant="secondary">
                {conn.flavor === "cloud"
                  ? t("flavorCloud")
                  : t("flavorDatacenter")}
              </Badge>
            </CardDescription>
            <CardAction className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={`/admin/jira/${conn.id}`} />}
              >
                <Pencil className="size-4" />
                {tCommon("edit")}
              </Button>
              <TooltipHint label={tCommon("delete")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={isPending}
                  onClick={() => onDelete(conn)}
                  aria-label={tCommon("delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </TooltipHint>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <code className="flex-1 break-all font-mono text-sm">
                {conn.webhookUrl}
              </code>
              <CopyButton value={conn.webhookUrl} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
