import { TriangleAlert, X } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NewEnvironmentPlan } from "@/lib/setup/new-environment";

type PlanTarget = NewEnvironmentPlan["setup"]["targets"][number];

function BranchField({
  id,
  branch,
  onBranch,
}: {
  id: string;
  branch: string;
  onBranch: (branch: string) => void;
}) {
  const t = useTranslations("newEnvironment");
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="shrink-0 font-normal">
        {t("branch")}
      </Label>
      <Input
        id={id}
        className="font-mono"
        autoComplete="off"
        value={branch}
        onChange={(e) => onBranch(e.target.value.trim())}
      />
    </div>
  );
}

/** What the last check found for a service, and its default deploy dir. */
function TargetSummary({
  target,
  pipeline,
}: {
  target: PlanTarget;
  pipeline: string | null;
}) {
  const t = useTranslations("newEnvironment");
  return (
    <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
      <p>
        {target.services.length > 0
          ? t("detected", { services: target.services.join(", ") })
          : t("detectedNone")}
        {pipeline && ` · ${pipeline}`}
      </p>
      <p className="break-all font-mono text-xs">
        {t("deployDir", { dir: target.deployDir })}
      </p>
    </div>
  );
}

/**
 * A registered service the environment deploys: its key and repository, its
 * branch, what the last check found (detection, default deploy dir) and its
 * issue.
 */
export function ServiceListRow({
  componentKey,
  repoFullName,
  branch,
  index,
  plan,
  issue,
  message,
  onBranch,
  onRemove,
}: {
  componentKey: string;
  repoFullName: string | null;
  branch: string;
  index: number;
  /** The last check, when it is about the services listed now. */
  plan: NewEnvironmentPlan | null;
  issue: string | undefined;
  message: (code: string) => string;
  onBranch: (branch: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("newEnvironment");
  const target = plan?.setup.targets.find(
    (x) => x.componentKey === componentKey
  );
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="truncate font-mono text-sm font-medium">
            {componentKey}
          </span>
          {repoFullName && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {repoFullName}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("removeService", { service: componentKey })}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      <BranchField
        id={`service-${index}-branch`}
        branch={branch}
        onBranch={onBranch}
      />
      {target && <TargetSummary target={target} pipeline={null} />}
      {issue && <FieldError>{message(issue)}</FieldError>}
    </li>
  );
}

/**
 * A repository the create registers as a new service: its branch, what
 * detection found (from the last check, matched by the key the check would
 * register) and its issue.
 */
export function RepoListRow({
  repoFullName,
  branch,
  index,
  componentKey,
  plan,
  issue,
  message,
  onBranch,
  onRemove,
}: {
  repoFullName: string;
  branch: string;
  index: number;
  /** The registered component, else the one the check would register. */
  componentKey: string | null;
  /** The last check, when it is about the repositories listed now. */
  plan: NewEnvironmentPlan | null;
  issue: string | undefined;
  message: (code: string) => string;
  onBranch: (branch: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("newEnvironment");
  const registration = plan?.registrations.find(
    (r) => r.repoFullName === repoFullName
  );
  const key = componentKey ?? registration?.componentKey ?? null;
  const target = key
    ? plan?.setup.targets.find((x) => x.componentKey === key)
    : undefined;
  const warned = (code: string) =>
    plan?.warnings.some((w) => w.field === `repos.${index}` && w.code === code);
  const notNotifying = warned("pipelineNotNotifying");
  const fileMissing = warned("pipelineFileMissing");
  const branchId = `repo-${index}-branch`;
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {repoFullName}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("removeRepo", { repo: repoFullName })}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      <BranchField id={branchId} branch={branch} onBranch={onBranch} />
      {target && (
        <TargetSummary
          target={target}
          pipeline={
            registration
              ? registration.pipelineMode === "generated"
                ? t("pipelineGenerated")
                : t("pipelineCustom")
              : null
          }
        />
      )}
      {notNotifying && (
        <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            {t.rich("pipelineNotNotifying", {
              code: (chunks) => (
                <code className="font-mono text-sm">{chunks}</code>
              ),
            })}
          </span>
        </p>
      )}
      {fileMissing && (
        <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("pipelineFileMissing")}</span>
        </p>
      )}
      {issue && <FieldError>{message(issue)}</FieldError>}
    </li>
  );
}
