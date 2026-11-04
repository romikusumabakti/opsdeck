import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { GitCommitHorizontal, KeyRound, Loader2, Package } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type AppComponentRow,
  listAppsQuery,
  retryFallbackCommit,
  rotateNotifySecret,
  useCanRegisterApp,
} from "@/web/api/apps";
import { ApiError } from "@/web/api/client";
import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";
import { loaderQuery } from "@/web/query-client";
import { FallbackStatus } from "./-components/apps/fallback-status";

export const Route = createFileRoute("/$locale/_app/apps/$appKey")({
  loader: async ({ params: { appKey }, context: { queryClient } }) => {
    const [apps] = await Promise.all([
      loaderQuery(queryClient, listAppsQuery()),
      loaderQuery(queryClient, meQuery()),
      loaderQuery(queryClient, getMyProjectAccessQuery()),
    ]);
    if (!apps?.some((app) => app.appKey === appKey)) throw notFound();
  },
  component: AppDetailPage,
});

function AppDetailPage() {
  const { appKey } = Route.useParams();
  const t = useTranslations("apps");
  const app = useSuspenseQuery(listAppsQuery()).data.find(
    (a) => a.appKey === appKey
  );
  const canRegister = useCanRegisterApp();
  if (!app) return null;

  return (
    <>
      <PageHeader title={app.name} subtitle={app.appKey} />
      <div className="flex flex-col gap-4 max-w-3xl w-full">
        {app.components.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noComponents")}</p>
        )}
        {app.components.map((component) => (
          <ComponentCard
            key={component.componentKey}
            appKey={app.appKey}
            component={component}
            canManage={canRegister}
          />
        ))}
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

function ComponentCard({
  appKey,
  component,
  canManage,
}: {
  appKey: string;
  component: AppComponentRow;
  canManage: boolean;
}) {
  const t = useTranslations("apps");
  const tCommon = useTranslations("common");
  const [busy, setBusy] = useState<"rotate" | "commit" | null>(null);

  async function run(kind: "rotate" | "commit") {
    setBusy(kind);
    try {
      if (kind === "rotate") {
        await rotateNotifySecret(appKey, component.componentKey);
        toast.success(t("secretRotated"));
      } else {
        const updated = await retryFallbackCommit(
          appKey,
          component.componentKey
        );
        if (updated.fallbackCommitError) {
          toast.error(
            t("commitFailed", { reason: updated.fallbackCommitError })
          );
        } else {
          toast.success(t("commitDone"));
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        toast.error(error.message);
      } else {
        throw error;
      }
    } finally {
      setBusy(null);
    }
  }

  const generated = component.pipelineMode === "generated";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package className="size-5 text-muted-foreground" />
          <CardTitle className="text-base font-mono">
            {component.componentKey}
          </CardTitle>
          <Badge variant="outline">
            {generated ? t("modeGenerated") : t("modeCustom")}
          </Badge>
        </div>
        <CardDescription className="font-mono">
          {component.repoFullName}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2">
          <Detail
            label={t("bundleImage")}
            value={<span className="font-mono">{component.bundleImage}</span>}
          />
          <Detail
            label={t("ciRepoId")}
            value={
              <span className="font-mono">{component.ciRepoId ?? "—"}</span>
            }
          />
          <Detail
            label={t("fallbackFile")}
            value={<FallbackStatus component={component} showReason />}
          />
        </dl>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null || !component.ciRepoId}
                  />
                }
              >
                {busy === "rotate" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                {t("rotateSecret")}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("rotateConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("rotateConfirmBody")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => run("rotate")}>
                    {t("rotateSecret")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {generated && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => run("commit")}
              >
                {busy === "commit" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GitCommitHorizontal className="size-4" />
                )}
                {t("commitFallback")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
