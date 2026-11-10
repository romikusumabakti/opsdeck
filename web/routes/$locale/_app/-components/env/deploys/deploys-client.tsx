import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Hourglass,
  Loader2,
  Lock,
  Play,
  Plus,
  Rocket,
  ScrollText,
  Settings,
  Undo2,
  Zap,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { PageHeader } from "@/components/page-header";
import { useProjectCan } from "@/components/project-role";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import { firstLine, runActorLabel } from "@/lib/deploy/run-actor";
import { getActiveBuild, startComponentBuild } from "@/web/api/apps";
import { ApiError } from "@/web/api/client";
import {
  type DeployTargetState,
  deployTag,
  rollbackTarget,
} from "@/web/api/deploys";
import type { EnvironmentWithServers } from "@/web/api/environments";
import { ProvisioningPanel } from "../provisioning-panel";
import { DeployLockPanel, useDeployLock } from "./deploy-lock";
import { environmentServers } from "./target-form-dialog";

type Deployment = DeployTargetState["recentDeployments"][number];
type Build = DeployTargetState["recentBuilds"][number];
type ActiveRun = { runId: string; tag: string; componentKey: string };

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
            <code className="font-mono text-xs">
              {run.componentKey} · {run.tag}
            </code>
          ) : undefined
        }
      />
    </>
  );
}

function TargetCard({
  target,
  serverName,
  lockedReason,
  onRun,
}: {
  target: DeployTargetState;
  serverName: string;
  // Set while the environment is locked: manual deploys and rollbacks are off.
  lockedReason: string | null;
  onRun: (run: ActiveRun) => void;
}) {
  const t = useTranslations("deploys");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const canRun = useProjectCan({ deploy: ["run"] });
  const canRollback = useProjectCan({ deploy: ["rollback"] });
  // The tag being deployed or rolled back to, while its request is in flight.
  const [pending, setPending] = React.useState<string | null>(null);

  const latest = target.recentDeployments[0];
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

  async function start(tag: string, request: () => Promise<{ runId: string }>) {
    setPending(tag);
    try {
      const { runId } = await request();
      onRun({ runId, tag, componentKey: target.componentKey });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(null);
    }
  }

  async function onDeploy(tag: string) {
    const ok = await dialog.confirm({
      title: t("deployConfirmTitle", { tag }),
      description: t("deployConfirmDescription", {
        tag,
        app: target.componentKey,
        services,
      }),
      confirmText: t("deploy"),
      cancelText: tCommon("cancel"),
    });
    if (ok) await start(tag, () => deployTag(target.id, tag));
  }

  async function onRollback(tag: string) {
    const ok = await dialog.confirm({
      title: t("rollbackConfirmTitle", { tag }),
      description: t("rollbackConfirmDescription", {
        tag,
        app: target.componentKey,
      }),
      confirmText: t("rollbackTo", { tag }),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (ok) await start(tag, () => rollbackTarget(target.id));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{target.componentKey}</span>
          {target.autoDeploy && (
            <Badge variant="secondary">{t("autoDeploy")}</Badge>
          )}
          {latest?.status === "failed" && (
            <Badge variant="destructive">
              <CircleAlert data-icon="inline-start" />
              {t("lastDeployFailed")}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="truncate">
          <code className="font-mono text-xs">{target.sourceBranch}</code>
          {serverName && <span> · {serverName}</span>}
          <span> · </span>
          <code className="font-mono text-xs">
            {target.kind === "jar"
              ? `${target.deployDir}/${target.jarName}`
              : target.deployDir}
          </code>
          {target.kind === "jar" && (
            <>
              <span> · </span>
              <code className="font-mono text-xs">{target.systemdUnit}</code>
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{t("currentTag")}</span>
              {target.currentTag ? (
                <code className="font-mono">{target.currentTag}</code>
              ) : (
                <span className="italic text-muted-foreground">
                  {t("neverDeployed")}
                </span>
              )}
            </div>
            {target.currentStatus === "failed" && target.currentTag && (
              <p className="flex items-center gap-1.5 text-destructive">
                <CircleAlert className="size-4 shrink-0" />
                {t("currentTagFailed", { tag: target.currentTag })}
              </p>
            )}
          </div>
          {canRollback && target.previousTag && (
            <DisabledHint reason={lockedReason}>
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null || lockedReason !== null}
                onClick={() => onRollback(target.previousTag as string)}
              >
                {pending === target.previousTag ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Undo2 data-icon="inline-start" />
                )}
                {t("rollbackTo", { tag: target.previousTag })}
              </Button>
            </DisabledHint>
          )}
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("buildsTitle")}</h3>
          {target.deployNextBuild && (
            <WaitingForFirstBuild branch={target.sourceBranch} />
          )}
          {target.recentBuilds.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {t("buildsEmpty", { branch: target.sourceBranch })}
              </p>
              {target.appKey && (
                <FirstBuild
                  appKey={target.appKey}
                  componentKey={target.componentKey}
                  branch={target.sourceBranch}
                  canStart={canRun}
                  deploysOnArrival={target.autoDeploy || target.deployNextBuild}
                />
              )}
            </div>
          ) : (
            <BuildsTable
              builds={target.recentBuilds}
              // Only a tag that deployed cleanly is pointless to redeploy; the
              // tag of a failed deploy can be retried.
              deployedTag={
                target.currentStatus === "success" ? target.currentTag : null
              }
              pending={pending}
              lockedReason={lockedReason}
              onDeploy={canRun ? onDeploy : null}
            />
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("deploymentsTitle")}</h3>
          {target.recentDeployments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("deploymentsEmpty")}
            </p>
          ) : (
            <DeploymentsTable
              deployments={target.recentDeployments}
              onViewRun={(d, runId) =>
                onRun({
                  runId,
                  tag: d.tag,
                  componentKey: target.componentKey,
                })
              }
            />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * Shown while the target is flagged `deploy_next_build`: provisioning found no
 * build of the branch, so the next one that arrives is deployed once.
 */
export function WaitingForFirstBuild({ branch }: { branch: string }) {
  const t = useTranslations("deploys");
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
    >
      <Hourglass className="size-4 shrink-0" />
      {t("waitingForFirstBuild", { branch })}
    </p>
  );
}

const ACTIVE_BUILD_POLL_MS = 10_000;

/**
 * The branch's first build while none has arrived yet: the pipeline already
 * running in Woodpecker (polled until it ends), or else Start build for a
 * caller who runs deploys. The server decides who may start one: admins, and
 * callers who run deploys where a target deploys this branch.
 */
export function FirstBuild({
  appKey,
  componentKey,
  branch,
  canStart,
  deploysOnArrival,
}: {
  appKey: string;
  componentKey: string;
  branch: string;
  canStart: boolean;
  // Auto-deploy is on or the next build is flagged to deploy once.
  deploysOnArrival: boolean;
}) {
  const t = useTranslations("deploys");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const [starting, setStarting] = React.useState(false);
  const queryKey = ["activeBuild", appKey, componentKey, branch];
  const { data: active } = useQuery({
    queryKey,
    queryFn: () => getActiveBuild(appKey, componentKey, branch),
    refetchInterval: (query) =>
      query.state.data ? ACTIVE_BUILD_POLL_MS : false,
  });

  // A pipeline that just ended may have delivered the build: re-read them.
  const wasActive = React.useRef(false);
  React.useEffect(() => {
    if (active) {
      wasActive.current = true;
    } else if (active === null && wasActive.current) {
      wasActive.current = false;
      queryClient.invalidateQueries({ queryKey: ["deploys"] });
    }
  }, [active, queryClient]);

  async function onStart() {
    setStarting(true);
    try {
      const { number } = await startComponentBuild(
        appKey,
        componentKey,
        branch
      );
      toast.success(t("buildStarted", { number }));
      queryClient.invalidateQueries({ queryKey: ["deploys"] });
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tCommon("errorGeneric")
      );
    } finally {
      setStarting(false);
    }
  }

  if (active) {
    const label = t("buildRunning", { number: active.number });
    return (
      <p
        role="status"
        className="flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        {active.url ? (
          <a
            href={active.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            {label}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        ) : (
          label
        )}
      </p>
    );
  }

  if (!canStart) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={starting}
      title={t(deploysOnArrival ? "startBuildHint" : "startBuildHintManual", {
        branch,
      })}
      onClick={onStart}
    >
      {starting ? (
        <Loader2 data-icon="inline-start" className="animate-spin" />
      ) : (
        <Play data-icon="inline-start" />
      )}
      {t("startBuild")}
    </Button>
  );
}

function BuildsTable({
  builds,
  deployedTag,
  pending,
  lockedReason,
  onDeploy,
}: {
  builds: Build[];
  deployedTag: string | null;
  pending: string | null;
  lockedReason: string | null;
  // Null when the caller may not deploy: the column is left out entirely.
  onDeploy: ((tag: string) => void) | null;
}) {
  const t = useTranslations("deploys");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("colTag")}</TableHead>
          <TableHead>{t("colCommit")}</TableHead>
          <TableHead>{t("colReceived")}</TableHead>
          <TableHead>
            <span className="sr-only">{t("pipeline")}</span>
          </TableHead>
          {onDeploy && (
            <TableHead>
              <span className="sr-only">{t("deploy")}</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {builds.map((build) => (
          <TableRow key={build.id}>
            <TableCell className="font-mono text-xs">{build.tag}</TableCell>
            <TableCell
              className="font-mono text-xs text-muted-foreground"
              title={build.commitSha}
            >
              {build.commitSha.slice(0, 7)}
              <BuildCommitDetail build={build} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              <RelativeTime date={build.receivedAt} />
            </TableCell>
            <TableCell>
              {build.pipelineUrl && (
                <a
                  href={build.pipelineUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                  {t("pipeline")}
                </a>
              )}
            </TableCell>
            {onDeploy && (
              <TableCell className="text-end">
                <DisabledHint
                  reason={
                    build.tag === deployedTag
                      ? t("alreadyDeployed")
                      : lockedReason
                  }
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      pending !== null ||
                      lockedReason !== null ||
                      build.tag === deployedTag
                    }
                    onClick={() => onDeploy(build.tag)}
                  >
                    {pending === build.tag ? (
                      <Loader2
                        data-icon="inline-start"
                        className="animate-spin"
                      />
                    ) : (
                      <Rocket data-icon="inline-start" />
                    )}
                    {t("deploy")}
                  </Button>
                </DisabledHint>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// The commit's first message line, with the author's email on hover.
function BuildCommitDetail({ build }: { build: Build }) {
  const message = firstLine(build.commitMessage);
  if (!message) return null;
  return (
    <span
      className="block max-w-[28rem] truncate font-sans"
      title={build.commitAuthorEmail ?? undefined}
    >
      {message}
    </span>
  );
}

function DeploymentsTable({
  deployments,
  onViewRun,
}: {
  deployments: Deployment[];
  onViewRun: (deployment: Deployment, runId: string) => void;
}) {
  const t = useTranslations("deploys");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("colTag")}</TableHead>
          <TableHead>{t("colTrigger")}</TableHead>
          <TableHead>{t("colStatus")}</TableHead>
          <TableHead>{t("colBy")}</TableHead>
          <TableHead>{t("colTime")}</TableHead>
          <TableHead>
            <span className="sr-only">{t("viewRun")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deployments.map((d) => (
          <TableRow key={d.id}>
            <TableCell className="font-mono text-xs">{d.tag}</TableCell>
            <TableCell>{t(`trigger.${d.trigger}`)}</TableCell>
            <TableCell>
              <DeploymentStatusBadge status={d.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              <DeploymentActor deployment={d} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              <RelativeTime date={d.createdAt} />
            </TableCell>
            <TableCell className="text-end">
              {/* A held deployment has no run until the lock is released. */}
              {d.runId !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => d.runId && onViewRun(d, d.runId)}
                >
                  <ScrollText data-icon="inline-start" />
                  {t("viewRun")}
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeploymentActor({ deployment: d }: { deployment: Deployment }) {
  const t = useTranslations("deploys");
  const actor = runActorLabel({
    userName: d.userName,
    autoUserName: d.autoUser?.name,
    triggeredBy: d.triggeredBy,
    auto: d.trigger === "auto",
  });
  switch (actor.kind) {
    case "user":
      return actor.name;
    case "autoUser":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Zap className="size-3.5 shrink-0" aria-hidden />
          {t("byAutoUser", { user: actor.name })}
        </span>
      );
    case "auto":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Zap className="size-3.5 shrink-0" aria-hidden />
          {actor.by === null
            ? t("byAuto")
            : t("byAutoUser", { user: actor.by })}
        </span>
      );
    default:
      return <span className="italic">{t("userUnknown")}</span>;
  }
}

function DeploymentStatusBadge({ status }: { status: Deployment["status"] }) {
  const t = useTranslations("deploys");
  const label = t(`status.${status}`);
  switch (status) {
    case "success":
      return (
        <Badge className="bg-success/15 text-success border-transparent">
          <CheckCircle2 data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <CircleAlert data-icon="inline-start" />
          {label}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary">
          <Loader2 data-icon="inline-start" className="animate-spin" />
          {label}
        </Badge>
      );
    case "superseded":
      return <Badge variant="outline">{label}</Badge>;
    case "held":
      return (
        <Badge variant="outline">
          <Lock data-icon="inline-start" />
          {label}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{label}</Badge>;
  }
}

// A disabled button gets no pointer events of its own, so the tooltip hangs
// off a wrapper. Without a reason the button renders as is.
function DisabledHint({
  reason,
  children,
}: {
  reason: string | null;
  children: React.ReactNode;
}) {
  if (reason === null) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
