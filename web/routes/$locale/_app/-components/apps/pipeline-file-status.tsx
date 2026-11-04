import { Loader2, RotateCw } from "lucide-react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AppComponentRow } from "@/web/api/apps";

/**
 * Where a component's pipeline file stands: custom components keep their own
 * file; generated ones show, per built branch, the committed pipeline file or
 * "not committed" with the reason the last commit failed. With `onRetry`, a
 * branch whose last commit failed gets a button to commit it again.
 */
export function PipelineFileStatus({
  component,
  showReason = false,
  onRetry,
  retrying = null,
  disabled = false,
}: {
  component: Pick<
    AppComponentRow,
    "pipelineMode" | "buildSpec" | "pipelineFileCommits"
  >;
  showReason?: boolean;
  onRetry?: (branch: string) => void;
  /** The branch being committed again (shows a spinner), or null. */
  retrying?: string | null;
  /** Disables the retry buttons while any action on the component runs. */
  disabled?: boolean;
}) {
  const t = useTranslations("apps");
  if (component.pipelineMode === "custom") {
    return (
      <span className="text-sm text-muted-foreground">{t("repoFile")}</span>
    );
  }
  const commits = component.pipelineFileCommits ?? {};
  // The built branches first, then any recorded branch the spec dropped.
  const branches = [
    ...new Set([
      ...(component.buildSpec?.branches ?? []),
      ...Object.keys(commits),
    ]),
  ];
  return (
    <ul className="flex flex-col gap-1.5">
      {branches.map((branch) => {
        const { sha, error } = commits[branch] ?? {};
        return (
          <li key={branch} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs">{branch}</span>
              {sha && (
                <Badge variant="secondary" className="font-mono">
                  {t("committed", { sha: sha.slice(0, 7) })}
                </Badge>
              )}
              {(error || !sha) && (
                <Badge
                  variant={error ? "destructive" : "outline"}
                  title={error}
                >
                  {sha ? t("lastCommitFailed") : t("notCommitted")}
                </Badge>
              )}
              {onRetry && error && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("retryBranch", { branch })}
                  title={t("retryBranch", { branch })}
                  disabled={disabled}
                  onClick={() => onRetry(branch)}
                >
                  {retrying === branch ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RotateCw />
                  )}
                </Button>
              )}
            </div>
            {showReason && error && (
              <p className="text-xs text-muted-foreground break-words">
                {error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
