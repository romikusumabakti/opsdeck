import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { useProjectCan } from "@/components/project-role";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/web/api/client";
import {
  type DeployTargetState,
  deployTag,
  rollbackTarget,
} from "@/web/api/deploys";
import { useDeployLock } from "./deploy-lock";
import { MarkReleaseDialog, type ReleaseSource } from "./mark-release-dialog";
import {
  type CardActions,
  type PendingAction,
  TargetHeader,
} from "./target-header";
import { Timeline } from "./timeline";
import {
  buildTimeline,
  headerState,
  type TimelineDeployment,
} from "./timeline-model";

type Deployment = DeployTargetState["recentDeployments"][number];
export type ActiveRun = { runId: string; tag: string; componentKey: string };

export const isActive = (d: Deployment) =>
  d.status === "queued" || d.status === "running";

export function TargetCard({
  target,
  serverName,
  lockedReason,
  environmentBusy,
  environmentId,
  onRun,
}: {
  target: DeployTargetState;
  serverName: string;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  // A deploy is queued or running somewhere in the environment.
  environmentBusy: boolean;
  environmentId: string;
  onRun: (run: ActiveRun) => void;
}) {
  const t = useTranslations("deploys");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const canRun = useProjectCan({ deploy: ["run"] });
  const canRollback = useProjectCan({ deploy: ["rollback"] });
  const canRelease = useProjectCan({ release: ["create"] });
  // The same cached query DeploysClient reads for `lockedReason`.
  const lock = useDeployLock(environmentId).data?.lock ?? null;
  const [releaseSource, setReleaseSource] =
    React.useState<ReleaseSource | null>(null);
  // The deploy or rollback whose request is in flight.
  const [pending, setPending] = React.useState<PendingAction | null>(null);

  const header = React.useMemo(() => headerState(target), [target]);
  const rows = React.useMemo(() => buildTimeline(target), [target]);
  const timelineCtx = {
    canRun,
    canRollback,
    canRelease,
    // Only a jar or static build can be kept as a release.
    releasableKind: target.kind === "jar" || target.kind === "static",
    // No second rollback while one runs, as in the header.
    rollbackBusy: header.rollbackBusy,
  };
  const queuedHint = environmentBusy ? t("startsAfterRunning") : null;
  const services = target.services.join(", ");

  function errorText(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 503) return t("deployDisabled");
      // Messages are the API's own (server/services/deploys.ts).
      if (error.message === "No previous successful deploy") {
        return t("noPreviousDeploy");
      }
      if (error.message === "Build not found") return t("buildNotFound");
      if (error.message === "Target not found") return t("targetNotFound");
      return error.message;
    }
    return error instanceof Error ? error.message : tCommon("errorGeneric");
  }

  async function start(
    action: PendingAction,
    request: () => Promise<{ runId: string }>
  ) {
    const { tag } = action;
    setPending(action);
    try {
      const { runId } = await request();
      onRun({ runId, tag, componentKey: target.componentKey });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(null);
    }
  }

  // What the deploy restarts: the compose services, the jar's unit, or
  // (static) nothing but an nginx reload.
  function deployConfirmDescription(tag: string): string {
    const service = target.componentKey;
    if (target.kind === "jar") {
      return t("deployConfirmDescriptionJar", {
        tag,
        service,
        unit: target.systemdUnit ?? "",
      });
    }
    if (target.kind === "static") {
      return t("deployConfirmDescriptionStatic", { tag, service });
    }
    return t("deployConfirmDescription", { tag, service, services });
  }

  async function deploy(tag: string) {
    // The tag the server runs (or failed to run): the row menu's Redeploy.
    const redeploy = tag === target.currentTag;
    const ok = await dialog.confirm({
      title: t(redeploy ? "redeployConfirmTitle" : "deployConfirmTitle", {
        tag,
      }),
      description: deployConfirmDescription(tag),
      confirmText: t(redeploy ? "redeploy" : "deploy"),
      cancelText: tCommon("cancel"),
    });
    if (ok) {
      await start({ kind: "deploy", tag }, () => deployTag(target.id, tag));
    }
  }

  async function rollback() {
    const tag = target.previousTag;
    if (!tag) return;
    const ok = await dialog.confirm({
      title: t("rollbackConfirmTitle", { tag }),
      description: t("rollbackConfirmDescription", {
        tag,
        service: target.componentKey,
      }),
      confirmText: t("rollbackTo", { tag }),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (ok) {
      await start({ kind: "rollback", tag }, () => rollbackTarget(target.id));
    }
  }

  const actions: CardActions = {
    deploy,
    rollback,
    markRelease(d: TimelineDeployment) {
      // Without its build row the source commit is unknown, and the server
      // refuses the release.
      if (!d.build) return;
      setReleaseSource({
        environmentId,
        deploymentId: d.id,
        componentKey: target.componentKey,
        tag: d.tag,
        branch: d.build.branch,
        commitSha: d.build.commitSha,
      });
    },
    viewLog({ runId, tag }) {
      onRun({ runId, tag, componentKey: target.componentKey });
    },
    pending,
  };

  return (
    <Card>
      <TargetHeader
        target={target}
        serverName={serverName}
        header={header}
        actions={actions}
        lockedReason={lockedReason}
        lock={lock}
        queuedHint={queuedHint}
        canRun={canRun}
        canRollback={canRollback}
      />

      <CardContent>
        <Timeline
          target={target}
          rows={rows}
          actions={actions}
          ctx={timelineCtx}
          lockedReason={lockedReason}
          queuedHint={queuedHint}
        />
      </CardContent>
      <MarkReleaseDialog
        source={releaseSource}
        onOpenChange={(open) => {
          if (!open) setReleaseSource(null);
        }}
      />
    </Card>
  );
}
