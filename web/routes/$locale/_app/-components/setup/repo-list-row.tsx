import { TriangleAlert, X } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NewEnvironmentPlan } from "@/lib/setup/new-environment";

/**
 * One repository of the New environment page: its branch, what detection
 * found (from the last check, matched by component key) and its issue.
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
      <div className="flex items-center gap-2">
        <Label
          htmlFor={`repo-${index}-branch`}
          className="shrink-0 font-normal"
        >
          {t("branch")}
        </Label>
        <Input
          id={`repo-${index}-branch`}
          className="font-mono"
          autoComplete="off"
          value={branch}
          onChange={(e) => onBranch(e.target.value.trim())}
        />
      </div>
      {target && (
        <p className="text-sm text-muted-foreground">
          {target.services.length > 0
            ? t("detected", { services: target.services.join(", ") })
            : t("detectedNone")}
          {registration &&
            ` · ${
              registration.pipelineMode === "generated"
                ? t("pipelineGenerated")
                : t("pipelineCustom")
            }`}
        </p>
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
