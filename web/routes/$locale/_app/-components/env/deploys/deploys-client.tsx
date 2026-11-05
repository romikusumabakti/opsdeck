import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  Rocket,
  ScrollText,
  Undo2,
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
  CardAction,
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
import { ApiError } from "@/web/api/client";
import {
  type DeployTargetState,
  deployTag,
  rollbackTarget,
} from "@/web/api/deploys";
import type { EnvironmentWithServers } from "@/web/api/environments";
import { environmentServers, TargetFormDialog } from "./target-form-dialog";

type Deployment = DeployTargetState["recentDeployments"][number];
type Build = DeployTargetState["recentBuilds"][number];
type ActiveRun = { runId: string; tag: string; componentKey: string };
type FormState = { target: DeployTargetState | null } | null;

export function DeploysClient({
  environment,
  targets,
}: {
  environment: EnvironmentWithServers;
  targets: DeployTargetState[];
}) {
  const t = useTranslations("deploys");
  const queryClient = useQueryClient();
  const canConfigure = useProjectCan({ deploy: ["configure"] });
  const [form, setForm] = React.useState<FormState>(null);
  const [run, setRun] = React.useState<ActiveRun | null>(null);
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
            <Button onClick={() => setForm({ target: null })}>
              <Plus data-icon="inline-start" />
              {t("addTarget")}
            </Button>
          )
        }
      />

      {targets.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Rocket}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {targets.map((target) => (
            <TargetCard
              key={target.id}
              target={target}
              serverName={serverNames.get(target.serverId) ?? ""}
              onEdit={() => setForm({ target })}
              onRun={setRun}
            />
          ))}
        </div>
      )}

      <TargetFormDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
        environment={environment}
        target={form?.target ?? null}
      />

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
  onEdit,
  onRun,
}: {
  target: DeployTargetState;
  serverName: string;
  onEdit: () => void;
  onRun: (run: ActiveRun) => void;
}) {
  const t = useTranslations("deploys");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const canRun = useProjectCan({ deploy: ["run"] });
  const canRollback = useProjectCan({ deploy: ["rollback"] });
  const canConfigure = useProjectCan({ deploy: ["configure"] });
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
          <code className="font-mono text-xs">{target.deployDir}</code>
        </CardDescription>
        {canConfigure && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil data-icon="inline-start" />
              {t("editTarget")}
            </Button>
          </CardAction>
        )}
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
            <Button
              variant="outline"
              size="sm"
              disabled={pending !== null}
              onClick={() => onRollback(target.previousTag as string)}
            >
              {pending === target.previousTag ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Undo2 data-icon="inline-start" />
              )}
              {t("rollbackTo", { tag: target.previousTag })}
            </Button>
          )}
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("buildsTitle")}</h3>
          {target.recentBuilds.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("buildsEmpty", { branch: target.sourceBranch })}
            </p>
          ) : (
            <BuildsTable
              builds={target.recentBuilds}
              // Only a tag that deployed cleanly is pointless to redeploy; the
              // tag of a failed deploy can be retried.
              deployedTag={
                target.currentStatus === "success" ? target.currentTag : null
              }
              pending={pending}
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

function BuildsTable({
  builds,
  deployedTag,
  pending,
  onDeploy,
}: {
  builds: Build[];
  deployedTag: string | null;
  pending: string | null;
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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null || build.tag === deployedTag}
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
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
              {d.trigger === "auto"
                ? t("byAuto")
                : (d.userName ?? (
                    <span className="italic">{t("userUnknown")}</span>
                  ))}
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
    default:
      return <Badge variant="secondary">{label}</Badge>;
  }
}
