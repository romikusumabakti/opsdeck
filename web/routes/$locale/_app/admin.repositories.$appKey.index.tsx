import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  GitCommitHorizontal,
  KeyRound,
  ListTree,
  Loader2,
  Package,
  Plus,
} from "lucide-react";
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
import { Link } from "@/i18n/navigation";
import {
  type AppComponentRow,
  commitPipelineFile,
  listAppsQuery,
  rotateNotifySecret,
  useCanAddEnvironment,
  useCanManagePipelines,
} from "@/web/api/apps";
import { ApiError } from "@/web/api/client";
import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { PipelineFileStatus } from "./-components/apps/pipeline-file-status";

// One repository's components and pipeline state. Org integration:manage, as
// the Repositories list.
export const Route = createFileRoute(
  "/$locale/_app/admin/repositories/$appKey/"
)({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
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
  const tSetup = useTranslations("setupWizard");
  const app = useSuspenseQuery(listAppsQuery()).data.find(
    (a) => a.appKey === appKey
  );
  // Rotating secrets and committing pipeline files is for admins.
  const canManage = useCanManagePipelines();
  // Anyone who can create environments in some project.
  const canAddEnvironment = useCanAddEnvironment();
  if (!app) return null;

  return (
    <>
      <PageHeader
        title={app.name}
        subtitle={app.appKey}
        action={
          (canAddEnvironment || canManage) && (
            <div className="flex flex-wrap gap-2">
              {canManage && (
                // The variable templates are for integration:manage, like
                // the actions below.
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      href={`/admin/repositories/${app.appKey}/variables`}
                    />
                  }
                >
                  <ListTree data-icon="inline-start" />
                  {t("variableTemplates")}
                </Button>
              )}
              {canAddEnvironment && (
                <Button
                  nativeButton={false}
                  render={
                    <Link href={`/apps/${app.appKey}/environments/new`} />
                  }
                >
                  <Plus data-icon="inline-start" />
                  {tSetup("addEnvironment.button")}
                </Button>
              )}
            </div>
          )
        }
      />
      <div className="flex flex-col gap-4 max-w-3xl w-full">
        {app.components.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noComponents")}</p>
        )}
        {app.components.map((component) => (
          <ComponentCard
            key={component.componentKey}
            appKey={app.appKey}
            component={component}
            canManage={canManage}
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
  // "rotate", "commit" (every branch), or the one branch being committed.
  const [busy, setBusy] = useState<
    { kind: "rotate" } | { kind: "commit"; branch?: string } | null
  >(null);

  async function rotate() {
    await rotateNotifySecret(appKey, component.componentKey);
    toast.success(t("secretRotated"));
  }

  async function commit(branch?: string) {
    const updated = await commitPipelineFile(
      appKey,
      component.componentKey,
      branch
    );
    const commits = updated.pipelineFileCommits ?? {};
    const tried =
      branch === undefined
        ? [...new Set(updated.buildSpec?.branches)]
        : [branch];
    const failed = tried.filter((b) => commits[b]?.error);
    for (const b of failed) {
      toast.error(
        t("commitFailed", { branch: b, reason: commits[b]?.error ?? "" })
      );
    }
    if (failed.length === 0) {
      toast.success(
        branch === undefined
          ? t("commitDone")
          : t("commitDoneBranch", { branch })
      );
    }
  }

  async function run(action: NonNullable<typeof busy>) {
    setBusy(action);
    try {
      if (action.kind === "rotate") await rotate();
      else await commit(action.branch);
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
            label={t("pipelineFile")}
            value={
              <PipelineFileStatus
                component={component}
                showReason
                onRetry={
                  canManage
                    ? (branch) => run({ kind: "commit", branch })
                    : undefined
                }
                retrying={
                  busy?.kind === "commit" ? (busy.branch ?? null) : null
                }
                disabled={busy !== null}
              />
            }
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
                {busy?.kind === "rotate" ? (
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
                  <AlertDialogAction onClick={() => run({ kind: "rotate" })}>
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
                onClick={() => run({ kind: "commit" })}
              >
                {busy?.kind === "commit" && busy.branch === undefined ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GitCommitHorizontal className="size-4" />
                )}
                {t("commitPipelineFile")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
