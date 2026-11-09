import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, RotateCw, ScrollText } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useProjectCan } from "@/components/project-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { TeardownStep } from "@/lib/db/schema";
import { canOrg } from "@/lib/permissions";
import { ApiError } from "@/web/api/client";
import {
  cancelTeardown,
  getTeardownQuery,
  retryTeardown,
  type TeardownStatus,
} from "@/web/api/environments";
import { useMe } from "@/web/api/session";
import { useTeardownErrorText } from "./use-teardown-error-text";

// While a teardown runs, poll so the current step moves on without a reload.
const RUNNING_POLL_MS = 3000;

type Step = TeardownStatus["steps"][number];

/** The step the teardown is on: running, else stopped at, else next. */
function currentStep(steps: Step[]): Step | undefined {
  return (
    steps.find((s) => s.status === "running") ??
    steps.find((s) => s.status === "failed") ??
    steps.find((s) => s.status === "pending") ??
    steps.at(-1)
  );
}

/**
 * The banner of the environment pages while the environment is being deleted
 * (or its deletion stopped): the current step, the run log, and once stopped
 * the failure's message with Retry, and Cancel deletion while the backend
 * still allows it. Once the environment is gone, goes to the project page.
 * A stop for escrowed variables lets an admin with integration:manage
 * confirm their deletion with the retry.
 */
export function TeardownBanner({
  environmentId,
  projectKey,
}: {
  environmentId: string;
  projectKey: string;
}) {
  const t = useTranslations("teardown");
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("environmentSettings");
  const router = useRouter();
  const dialog = useDialog();
  const canDelete = useProjectCan({ environment: ["delete"] });
  const canDeleteEscrowed = canOrg(useMe()?.orgRole, {
    integration: ["manage"],
  });
  const errorText = useTeardownErrorText();
  const [logRunId, setLogRunId] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const query = useQuery({
    ...getTeardownQuery(environmentId),
    refetchInterval: (q) => (q.state.data?.running ? RUNNING_POLL_MS : false),
  });
  // Only the 404 that ends a teardown this page saw running is "deleted":
  // the data of the last successful poll stays while the error is shown. A
  // 404 without one (Remove from Panel only, lost access) is not ours.
  const gone =
    query.error instanceof ApiError &&
    query.error.status === 404 &&
    query.data?.running === true;

  React.useEffect(() => {
    if (!gone) return;
    toast.success(t("banner.deleted"));
    router.push(`/${projectKey}`);
  }, [gone, projectKey, router, t]);

  const teardown = query.data;
  if (!teardown) return null;
  const step = currentStep(teardown.steps);
  if (!step) return null;
  const { running } = teardown;
  const stepName = t(`steps.${step.kind as TeardownStep["kind"]}`);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(errorText(error.code));
        return;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const escrowStop = step.lastError === "environmentHasEscrowedVariables";

  async function retry() {
    if (escrowStop && canDeleteEscrowed) {
      const confirmed = await dialog.confirm({
        title: tSettings("deleteEscrowedTitle"),
        description: tSettings("deleteEscrowedDescription"),
        confirmText: tCommon("delete"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!confirmed) return;
      await run(() =>
        retryTeardown(environmentId, { confirmEscrowedDeletion: true })
      );
      return;
    }
    await run(() => retryTeardown(environmentId));
  }

  return (
    <>
      <Alert variant={running ? "default" : "destructive"} className="mb-6">
        {running ? <Loader2 className="animate-spin" /> : <CircleAlert />}
        <AlertTitle>
          {running ? t("banner.runningTitle") : t("banner.failedTitle")}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <p>
            {running
              ? t("banner.runningStep", { step: stepName })
              : t("banner.failedStep", { step: stepName })}
          </p>
          {!running && step.lastError && <p>{errorText(step.lastError)}</p>}
          <div className="flex flex-wrap gap-2">
            {teardown.runId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLogRunId(teardown.runId)}
              >
                <ScrollText data-icon="inline-start" />
                {t("banner.viewLog")}
              </Button>
            )}
            {!running && canDelete && (
              <Button size="sm" disabled={busy} onClick={() => void retry()}>
                <RotateCw data-icon="inline-start" />
                {t("banner.retry")}
              </Button>
            )}
            {!running && canDelete && teardown.cancellable && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                {t("banner.cancel")}
              </Button>
            )}
          </div>
        </AlertDescription>
      </Alert>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("banner.cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("banner.cancelDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("close")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmCancel(false);
                void run(
                  () => cancelTeardown(environmentId),
                  t("banner.cancelled")
                );
              }}
            >
              {t("banner.cancelConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <LiveRunDialog
        runId={logRunId}
        onOpenChange={(open) => {
          if (!open) setLogRunId(null);
        }}
        title={t("banner.logTitle")}
      />
    </>
  );
}
