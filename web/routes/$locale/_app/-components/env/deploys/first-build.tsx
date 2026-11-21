import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Hourglass, Loader2, Play } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { getActiveBuild, startComponentBuild } from "@/web/api/service-catalog";

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
  componentKey,
  branch,
  canStart,
  deploysOnArrival,
}: {
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
  const queryKey = ["activeBuild", componentKey, branch];
  const { data: active } = useQuery({
    queryKey,
    queryFn: () => getActiveBuild(componentKey, branch),
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
      const { number } = await startComponentBuild(componentKey, branch);
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
