import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/badge";
import type { AppComponentRow } from "@/web/api/apps";

/**
 * Where a component's pipeline file stands: custom components keep their own
 * file; generated ones show the committed fallback, or "not committed" with
 * the reason the last commit failed.
 */
export function FallbackStatus({
  component,
  showReason = false,
}: {
  component: Pick<
    AppComponentRow,
    "pipelineMode" | "fallbackCommittedSha" | "fallbackCommitError"
  >;
  showReason?: boolean;
}) {
  const t = useTranslations("apps");
  if (component.pipelineMode === "custom") {
    return (
      <span className="text-sm text-muted-foreground">{t("repoFile")}</span>
    );
  }
  const { fallbackCommittedSha: sha, fallbackCommitError: error } = component;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {sha && (
          <Badge variant="secondary" className="font-mono">
            {t("committed", { sha: sha.slice(0, 7) })}
          </Badge>
        )}
        {(error || !sha) && (
          <Badge
            variant={error ? "destructive" : "outline"}
            title={error ?? undefined}
          >
            {sha ? t("lastCommitFailed") : t("notCommitted")}
          </Badge>
        )}
      </div>
      {showReason && error && (
        <p className="text-xs text-muted-foreground break-words">{error}</p>
      )}
    </div>
  );
}
