import { useQueryClient } from "@tanstack/react-query";
import { Plus, Rocket, Settings } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { PageHeader } from "@/components/page-header";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import type { DeployTargetState } from "@/web/api/deploys";
import type { EnvironmentWithServers } from "@/web/api/environments";
import { ProvisioningPanel } from "../provisioning-panel";
import { DeployLockPanel, useDeployLock } from "./deploy-lock";
import { type ActiveRun, isActive, TargetCard } from "./target-card";
import { environmentServers } from "./target-form-dialog";

/**
 * Deploy history, deploys and rollbacks. Deploy targets are edited in
 * Settings → Source & Deploy (`settingsHref`); with none yet, the empty state
 * leads there with the add-target dialog open (`addTargetHref`).
 */
export function DeploysClient({
  environment,
  targets,
  settingsHref,
  addTargetHref,
}: {
  environment: EnvironmentWithServers;
  targets: DeployTargetState[];
  settingsHref: string;
  addTargetHref: string;
}) {
  const t = useTranslations("deploys");
  const queryClient = useQueryClient();
  const canConfigure = useProjectCan({ deploy: ["configure"] });
  const [run, setRun] = React.useState<ActiveRun | null>(null);
  const lock = useDeployLock(environment.id).data?.lock ?? null;
  const lockedReason = lock
    ? t("lock.disabledHint", { reason: lock.reason })
    : null;
  // Deploys in one environment run one at a time: a new one waits for this.
  const environmentBusy = targets.some((target) =>
    target.recentDeployments.some(isActive)
  );
  const serverNames = React.useMemo(
    () => new Map(environmentServers(environment).map((s) => [s.id, s.name])),
    [environment]
  );

  // The run keeps going server-side if the dialog is dismissed early; the
  // refetch on close shows whatever state the deployment has reached.
  function onRunOpenChange(open: boolean) {
    if (open) return;
    setRun(null);
    queryClient.invalidateQueries({ queryKey: ["deploys"] });
    // The dashboard's Running card shows what the deployment left running.
    queryClient.invalidateQueries({
      queryKey: ["environments", "getEnvironmentRunning"],
    });
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          canConfigure && (
            <Button
              variant="outline"
              render={<Link href={settingsHref} />}
              nativeButton={false}
              title={t("settingsHint")}
            >
              <Settings data-icon="inline-start" />
              {t("settingsLink")}
            </Button>
          )
        }
      />

      <DeployLockPanel
        environmentId={environment.id}
        ownerId={environment.ownerId ?? null}
      />

      <ProvisioningPanel environment={environment} targets={targets} />

      {targets.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Rocket}
            title={t("emptyTitle")}
            description={t(
              canConfigure ? "emptyDescription" : "emptyDescriptionReadOnly"
            )}
            action={
              canConfigure && (
                <Button
                  render={<Link href={addTargetHref} />}
                  nativeButton={false}
                >
                  <Plus data-icon="inline-start" />
                  {t("addTarget")}
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((target) => (
            <TargetCard
              key={target.id}
              target={target}
              serverName={serverNames.get(target.serverId) ?? ""}
              lockedReason={lockedReason}
              environmentBusy={environmentBusy}
              environmentId={environment.id}
              onRun={setRun}
            />
          ))}
        </div>
      )}

      <LiveRunDialog
        runId={run?.runId ?? null}
        onOpenChange={onRunOpenChange}
        title={run ? t("runTitle", { tag: run.tag }) : t("title")}
        description={
          run ? (
            <code className="font-mono text-sm">
              {run.componentKey} · {run.tag}
            </code>
          ) : undefined
        }
      />
    </>
  );
}
