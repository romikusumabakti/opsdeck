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

// While a run is active, poll so step statuses move on without a reload.
const ACTIVE_POLL_MS = 3000;

type StepStatus = ProvisioningStep["status"];

/** What the sentences name; any lookup may miss, then the id is shown. */
export type ProvisioningLookups = {
  serverLabel: (serverId: string) => string | undefined;
  databaseHost: (
    id: string
  ) => { label: string; containerName: string; serverId: string } | undefined;
  componentKey: (targetId: string) => string | undefined;
};

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
 * API refuses the plan to anyone else.
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
    };
  }, [environment.services, hosts, targets]);

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

  if (!canRun || targets.length === 0 || !provisioning) return null;

  return (
    <>
      <ProvisioningPanelView
        plan={provisioning.plan}
        steps={provisioning.steps}
        activeRunId={provisioning.activeRunId}
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
  starting?: boolean;
  // A 422 code from the start request (missing_db_fields | no_targets).
  errorCode?: string | null;
  lookups: ProvisioningLookups;
  onProvision: () => void;
  onViewLog: (runId: string) => void;
}) {
  const t = useTranslations("provisioning");
  if (!canRun) return null;

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
          <Button size="sm" disabled={busy} onClick={onProvision}>
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
            {errorCode === "no_targets"
              ? t("error.no_targets")
              : errorCode === "missing_db_fields"
                ? t("error.missing_db_fields")
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
    </Card>
  );
}

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

const code = (chunks: React.ReactNode) => (
  <code className="font-mono text-xs">{chunks}</code>
);

// The human sentence of a step. Names fall back to ids when a lookup misses.
function StepSentence({
  spec,
  lookups,
}: {
  spec: ProvisioningStepSpec;
  lookups: ProvisioningLookups;
}) {
  const t = useTranslations("provisioning");
  switch (spec.kind) {
    case "prepare_deploy_dir":
      return t.rich("step.prepare_deploy_dir", {
        code,
        dir: spec.params.deployDir,
        server:
          lookups.serverLabel(spec.params.serverId) ?? spec.params.serverId,
      });
    case "create_database": {
      const host = lookups.databaseHost(spec.params.databaseHostId);
      const server = host ? lookups.serverLabel(host.serverId) : undefined;
      return t.rich(
        server ? "step.create_database" : "step.create_database_no_server",
        {
          code,
          database: spec.params.database,
          host: host?.containerName ?? spec.params.databaseHostId,
          server: server ?? "",
        }
      );
    }
    case "deploy":
      return t.rich("step.deploy", {
        code,
        branch: spec.params.branch,
        component:
          lookups.componentKey(spec.params.targetId) ?? spec.params.targetId,
      });
  }
}
