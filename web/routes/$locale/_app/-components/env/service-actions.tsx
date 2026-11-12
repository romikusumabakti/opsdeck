import { FileText, Loader2, Play, RotateCcw, Square } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import type { ServiceAction, ServiceRole } from "@/lib/services";
import { controlService, type ServiceStatusResult } from "@/web/api/services";

// The action in flight on the Stack card. Owned by the card so one action
// disables the buttons of every row.
export type PendingServiceAction = {
  role: ServiceRole;
  action: ServiceAction;
} | null;

export function ServiceActions({
  environmentId,
  role,
  title,
  serviceName,
  serverName,
  status,
  loading,
  logsHref,
  pending,
  onPendingChange,
  onRefresh,
}: {
  environmentId: string;
  role: ServiceRole;
  // The row's translated title (database, backend or frontend).
  title: string;
  serviceName: string;
  serverName: string;
  status: ServiceStatusResult | null;
  // A status fetch is in flight.
  loading: boolean;
  logsHref: string;
  pending: PendingServiceAction;
  onPendingChange: (next: PendingServiceAction) => void;
  onRefresh: () => void;
}) {
  const t = useTranslations("services");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const canControl = useProjectCan({ service: ["control"] });
  const canRestart = useProjectCan({ service: ["restart"] }) || canControl;
  const canLogs = useProjectCan({ service: ["logs"] });

  // The action that owns the open run dialog. Kept apart from `pending`
  // (cleared once the request returns) so the dialog title survives until the
  // user closes it.
  const [activeRun, setActiveRun] = React.useState<{
    runId: string;
    action: ServiceAction;
  } | null>(null);

  async function onAction(action: ServiceAction) {
    const ok = await dialog.confirm({
      title: t(`confirmTitle.${action}`),
      description: t("confirmDescription", {
        action: t(`actions.${action}`),
        target: title,
        serviceName,
      }),
      confirmText: t(`actions.${action}`),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    onPendingChange({ role, action });
    try {
      const { runId } = await controlService(environmentId, role, action);
      setActiveRun({ runId, action });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tCommon("errorGeneric"));
    } finally {
      onPendingChange(null);
    }
  }

  // Closing the dialog clears the run and refreshes the status. The run keeps
  // going server-side if the user dismisses early.
  function onOpenChange(open: boolean) {
    if (!open) {
      setActiveRun(null);
      onRefresh();
    }
  }

  const state = status?.state ?? "unknown";
  const busy = loading || pending !== null;
  const toggle: ServiceAction | null =
    canControl && state === "running"
      ? "stop"
      : canControl && state === "stopped"
        ? "start"
        : null;
  // No tooltip while the first status is still loading.
  const restartUnavailable =
    state === "not-found" || (state === "unknown" && !(loading && !status));

  function icon(action: ServiceAction, Icon: typeof Play) {
    return pending?.role === role && pending.action === action ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Icon />
    );
  }

  return (
    <>
      {toggle && (
        <Button
          size="xs"
          variant="outline"
          onClick={() => onAction(toggle)}
          disabled={busy}
        >
          {icon(toggle, toggle === "stop" ? Square : Play)}
          {t(`actions.${toggle}`)}
        </Button>
      )}
      {canRestart &&
        (restartUnavailable ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button size="xs" variant="outline" disabled>
                <RotateCcw />
                {t("actions.restart")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("unknownState")}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onAction("restart")}
            disabled={busy}
          >
            {icon("restart", RotateCcw)}
            {t("actions.restart")}
          </Button>
        ))}
      {canLogs &&
        (state === "not-found" ? (
          <Button size="xs" variant="outline" disabled>
            <FileText />
            {t("actions.logs")}
          </Button>
        ) : (
          <Button
            render={<Link href={logsHref} />}
            nativeButton={false}
            size="xs"
            variant="outline"
          >
            <FileText />
            {t("actions.logs")}
          </Button>
        ))}

      <LiveRunDialog
        runId={activeRun?.runId ?? null}
        onOpenChange={onOpenChange}
        title={activeRun ? t(`confirmTitle.${activeRun.action}`) : title}
        description={
          <>
            <code className="font-mono text-sm">{serviceName}</code>
            <span> · {serverName}</span>
          </>
        }
      />
    </>
  );
}
