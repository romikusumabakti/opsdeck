import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Loader2,
  Lock,
  PackageCheck,
  Rocket,
  RotateCcw,
  ScrollText,
  Zap,
} from "lucide-react";
import type * as React from "react";
import { useFormatter, useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { firstLine, runActorLabel } from "@/lib/deploy/run-actor";
import type { DeployTargetState } from "@/web/api/deploys";

type Deployment = DeployTargetState["recentDeployments"][number];
type Build = DeployTargetState["recentBuilds"][number];

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;

/** A run's length: "45s", "2m 5s", "1h 3m"; nothing when unknown. */
export function DurationText({ ms }: { ms: number | null }) {
  const format = useFormatter();
  if (ms === null) return null;
  const unit = (n: number, u: "second" | "minute" | "hour") =>
    format.number(n, { style: "unit", unit: u, unitDisplay: "narrow" });
  const total = Math.round(ms / SECOND_MS);
  if (total < MINUTE_S) return <>{unit(total, "second")}</>;
  if (total < HOUR_S) {
    return (
      <>
        {unit(Math.floor(total / MINUTE_S), "minute")}{" "}
        {unit(total % MINUTE_S, "second")}
      </>
    );
  }
  return (
    <>
      {unit(Math.floor(total / HOUR_S), "hour")}{" "}
      {unit(Math.floor((total % HOUR_S) / MINUTE_S), "minute")}
    </>
  );
}

/** Who started a deployment, as plain text for translated sentences. */
export function useDeploymentActorText(): (d: Deployment) => string {
  const t = useTranslations("deploys");
  return (d) => {
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
        return t("byAutoUser", { user: actor.name });
      case "auto":
        return actor.by === null
          ? t("byAuto")
          : t("byAutoUser", { user: actor.by });
      default:
        return t("userUnknown");
    }
  };
}

export function BuildsTable({
  builds,
  deployedTag,
  activeTags,
  pending,
  lockedReason,
  environmentBusy,
  onDeploy,
}: {
  builds: Build[];
  // The tag the target runs after a successful deploy: its row reads Redeploy.
  deployedTag: string | null;
  // Tags with a queued or running deployment on this target.
  activeTags: ReadonlySet<string>;
  pending: string | null;
  lockedReason: string | null;
  environmentBusy: boolean;
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
        {builds.map((build) => {
          const active = activeTags.has(build.tag);
          const redeploy = build.tag === deployedTag;
          const hint = active
            ? null
            : (lockedReason ??
              (environmentBusy ? t("startsAfterRunning") : null));
          return (
            <TableRow key={build.id}>
              <TableCell className="font-mono text-sm">{build.tag}</TableCell>
              <TableCell
                className="font-mono text-sm text-muted-foreground"
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
                  <ButtonHint hint={hint}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        active || pending !== null || lockedReason !== null
                      }
                      onClick={() => onDeploy(build.tag)}
                    >
                      {active || pending === build.tag ? (
                        <Loader2
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : redeploy ? (
                        <RotateCcw data-icon="inline-start" />
                      ) : (
                        <Rocket data-icon="inline-start" />
                      )}
                      {active
                        ? t("deploying")
                        : redeploy
                          ? t("redeploy")
                          : t("deploy")}
                    </Button>
                  </ButtonHint>
                </TableCell>
              )}
            </TableRow>
          );
        })}
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

export function DeploymentsTable({
  deployments,
  onMarkRelease,
  onViewRun,
}: {
  deployments: Deployment[];
  // Null when the caller may not make releases of this target.
  onMarkRelease:
    | ((
        deployment: Deployment,
        build: NonNullable<Deployment["build"]>
      ) => void)
    | null;
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
            <TableCell className="font-mono text-sm">{d.tag}</TableCell>
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
              {/* Without its build row the source commit is unknown, and
                  the server refuses the release. */}
              {onMarkRelease && d.status === "success" && d.build && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => d.build && onMarkRelease(d, d.build)}
                >
                  <PackageCheck data-icon="inline-start" />
                  {t("markRelease")}
                </Button>
              )}
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
// off a wrapper. Without a hint the button renders as is.
function ButtonHint({
  hint,
  children,
}: {
  hint: string | null;
  children: React.ReactNode;
}) {
  if (hint === null) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
