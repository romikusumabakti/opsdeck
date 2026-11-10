import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Loader2,
  Play,
  RotateCw,
  ScrollText,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useProjectCan } from "@/components/project-role";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  type ProvisioningPlanErrorCode,
  type ProvisioningStepSpec,
  sameStepSpec,
} from "@/lib/provisioning/plan";
import { ApiError } from "@/web/api/client";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import type { DeployTargetState } from "@/web/api/deploys";
import type { EnvironmentWithServers } from "@/web/api/environments";
import {
  getProvisioningQuery,
  type ProvisioningStep,
  startProvisioning,
} from "@/web/api/provisioning";
import {
  type ProvisioningLookups,
  StepSentence,
} from "./provisioning-step-sentence";

// While a run is active, poll so step statuses move on without a reload.
const ACTIVE_POLL_MS = 3000;

type StepStatus = ProvisioningStep["status"];

export type { ProvisioningLookups };

export type ProvisioningRow = {
  spec: ProvisioningStepSpec;
  status: StepStatus;
  error: string | null;
  runId: string | null;
};

/**
 * One row per planned step with the status of the stored step that has the
 * same kind and params. With no plan (an unplannable config) the stored steps
 * are shown as they are.
 */
export function provisioningRows(
  plan: ProvisioningStepSpec[],
  steps: ProvisioningStep[]
): ProvisioningRow[] {
  const taken = new Set<string>();
  const toRow = (
    spec: ProvisioningStepSpec,
    step?: ProvisioningStep
  ): ProvisioningRow => ({
    spec,
    status: step?.status ?? "pending",
    error: step?.lastError ?? null,
    runId: step?.lastRunId ?? null,
  });
  if (plan.length === 0) {
    return steps.map((step) =>
      toRow(
        { kind: step.kind, params: step.params } as ProvisioningStepSpec,
        step
      )
    );
  }
  return plan.map((spec) => {
    const step = steps.find((s) => !taken.has(s.id) && sameStepSpec(s, spec));
    if (step) taken.add(step.id);
    return toRow(spec, step);
  });
}

const STATUS_ICON = {
  pending: CircleDashed,
  running: Loader2,
  done: CheckCircle2,
  failed: CircleAlert,
} as const;

/**
 * The provisioning panel for the deploys page. Hidden without deploy:run: the
 * API refuses the plan to anyone else. Without targets it is hidden unless
 * provisioning has steps or an active run, and then only the hint (the
 * Deploys empty state offers adding a target); otherwise it shows when the API says so (`showPanel`: steps exist, the
 * environment never deployed successfully, its database is shared, or its
 * tunnel domain is not provisioned yet), so a running legacy environment gets
 * none.
 */
export function ProvisioningPanel({
  environment,
  targets,
}: {
  environment: EnvironmentWithServers;
  targets: DeployTargetState[];
}) {
  const t = useTranslations("provisioning");
  const queryClient = useQueryClient();
  const canRun = useProjectCan({ deploy: ["run"] });
  const [starting, setStarting] = React.useState(false);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [logRunId, setLogRunId] = React.useState<string | null>(null);

  const provisioning = useQuery({
    ...getProvisioningQuery(environment.id),
    enabled: canRun,
    refetchInterval: (query) =>
      query.state.data?.activeRunId ? ACTIVE_POLL_MS : false,
  }).data;
  const hosts = useQuery({ ...listDatabaseHostsQuery(), enabled: canRun }).data;

  // A deploy that finished can end the need for provisioning: re-read it so
  // the panel hides or updates. The current tag already changes when the
  // deploy script starts, so its status is part of the key: running → success
  // is the change that matters.
  const tagsKey = targets
    .map((x) => `${x.id}=${x.currentTag ?? ""}:${x.currentStatus ?? ""}`)
    .join(",");
  const previousTags = React.useRef(tagsKey);
  React.useEffect(() => {
    if (previousTags.current !== tagsKey) {
      queryClient.invalidateQueries({ queryKey: ["provisioning"] });
    }
    previousTags.current = tagsKey;
  }, [tagsKey, queryClient]);

  // A run's deploy step queues deployments the Deploys list does not poll
  // for: refresh it (current tag, recent deployments) when the run ends.
  const activeRunId = provisioning?.activeRunId ?? null;
  const previousRunId = React.useRef(activeRunId);
  React.useEffect(() => {
    if (previousRunId.current && !activeRunId) {
      queryClient.invalidateQueries({ queryKey: ["deploys"] });
    }
    previousRunId.current = activeRunId;
  }, [activeRunId, queryClient]);

  const domain = provisioning?.domain;
  const lookups = React.useMemo<ProvisioningLookups>(() => {
    const servers = new Map(
      environment.services.map((s) => [
        s.server.id,
        s.server.host ? `${s.server.name} (${s.server.host})` : s.server.name,
      ])
    );
    return {
      serverLabel: (id) => servers.get(id),
      databaseHost: (id) => hosts?.find((h) => h.id === id),
      componentKey: (id) => targets.find((x) => x.id === id)?.componentKey,
      // The GET names only the current binding's tunnel and policy.
      tunnelName: (id) =>
        (domain?.remoteTunnelId === id && domain.tunnelName) || undefined,
      policyName: (id) =>
        (domain?.accessPolicyId === id && domain.policyName) || undefined,
    };
  }, [environment.services, hosts, targets, domain]);

  async function onProvision() {
    setStarting(true);
    setErrorCode(null);
    try {
      await startProvisioning(environment.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        setErrorCode(error.message);
      } else if (error instanceof ApiError && error.status === 409) {
        toast.error(t("alreadyRunning"));
        await queryClient.invalidateQueries({ queryKey: ["provisioning"] });
      } else {
        toast.error(error instanceof Error ? error.message : t("startFailed"));
      }
    } finally {
      setStarting(false);
    }
  }

  const noTargets = targets.length === 0;
  // Without targets there is nothing to provision: the panel only stays to
  // show a run that exists (steps or an active run), with the hint.
  const hasRun =
    (provisioning?.steps.length ?? 0) > 0 || !!provisioning?.activeRunId;
  const show = noTargets ? hasRun : provisioning?.showPanel;
  if (!canRun || !show) return null;

  return (
    <>
      <ProvisioningPanelView
        plan={provisioning?.plan ?? []}
        steps={provisioning?.steps ?? []}
        activeRunId={provisioning?.activeRunId ?? null}
        noTargets={noTargets}
        canRun={canRun}
        starting={starting}
        errorCode={errorCode}
        lookups={lookups}
        onProvision={onProvision}
        onViewLog={setLogRunId}
      />
      <LiveRunDialog
        runId={logRunId}
        onOpenChange={(open) => {
          if (open) return;
          setLogRunId(null);
          queryClient.invalidateQueries({ queryKey: ["provisioning"] });
        }}
        title={t("logTitle")}
      />
    </>
  );
}

export function ProvisioningPanelView({
  plan,
  steps,
  activeRunId,
  canRun,
  noTargets = false,
  starting = false,
  errorCode = null,
  lookups,
  onProvision,
  onViewLog,
}: {
  plan: ProvisioningStepSpec[];
  steps: ProvisioningStep[];
  activeRunId: string | null;
  canRun: boolean;
  // No deploy targets: only the hint is shown, there is nothing to provision.
  noTargets?: boolean;
  starting?: boolean;
  // A 422 code from the start request (a ProvisioningPlanErrorCode).
  errorCode?: string | null;
  lookups: ProvisioningLookups;
  onProvision: () => void;
  onViewLog: (runId: string) => void;
}) {
  const t = useTranslations("provisioning");
  const tCommon = useTranslations("common");
  // Provision/Retry first lists what will run, deploys included.
  const [confirming, setConfirming] = React.useState(false);
  if (!canRun) return null;

  if (noTargets) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("error.no_targets")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const rows = provisioningRows(plan, steps);
  const failed = rows.some((row) => row.status === "failed");
  const busy = activeRunId !== null || starting;
  const logRunId =
    activeRunId ??
    rows.findLast((row) => row.status === "failed" && row.runId)?.runId ??
    rows.findLast((row) => row.runId)?.runId ??
    null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          {logRunId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onViewLog(logRunId)}
            >
              <ScrollText data-icon="inline-start" />
              {t("viewLog")}
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            {busy ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : failed ? (
              <RotateCw data-icon="inline-start" />
            ) : (
              <Play data-icon="inline-start" />
            )}
            {busy ? t("running") : failed ? t("retry") : t("provision")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {errorCode && (
          <p role="alert" className="text-sm text-destructive">
            {isPlanErrorCode(errorCode)
              ? t(`error.${errorCode}`)
              : t("startFailed")}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("emptyPlan")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <li key={index} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={row.status} />
                  <span>
                    <StepSentence spec={row.spec} lookups={lookups} />
                  </span>
                </div>
                {row.error && (
                  <p className="ps-2 text-xs text-destructive break-words">
                    {row.error}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm">
            {rows.map((row, index) => (
              <li key={index}>
                <StepSentence spec={row.spec} lookups={lookups} />
                {row.status === "done" && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({t("confirmDone")})
                  </span>
                )}
              </li>
            ))}
          </ol>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                onProvision();
              }}
            >
              {failed ? t("retry") : t("provision")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

const PLAN_ERROR_CODES: readonly ProvisioningPlanErrorCode[] = [
  "missing_db_fields",
  "missing_entry_port",
  "no_targets",
];
const isPlanErrorCode = (code: string): code is ProvisioningPlanErrorCode =>
  (PLAN_ERROR_CODES as readonly string[]).includes(code);

function StatusBadge({ status }: { status: StepStatus }) {
  const t = useTranslations("provisioning");
  const Icon = STATUS_ICON[status];
  const label = t(`status.${status}`);
  const icon = (
    <Icon
      data-icon="inline-start"
      className={status === "running" ? "animate-spin" : undefined}
    />
  );
  switch (status) {
    case "done":
      return (
        <Badge className="bg-success/15 text-success border-transparent">
          {icon}
          {label}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          {icon}
          {label}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary">
          {icon}
          {label}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline">
          {icon}
          {label}
        </Badge>
      );
  }
}
