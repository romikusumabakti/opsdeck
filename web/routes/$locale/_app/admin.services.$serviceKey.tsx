import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  GitCommitHorizontal,
  KeyRound,
  Loader2,
  Play,
  Plus,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/i18n/navigation";
import { branchSchema } from "@/lib/deploy/validation";
import { ApiError } from "@/web/api/client";
import {
  commitPipelineFile,
  getServiceQuery,
  rotateNotifySecret,
  type ServiceDetail,
  startComponentBuild,
} from "@/web/api/service-catalog";
import { listVariableTemplatesQuery } from "@/web/api/variables";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { PipelineFileStatus } from "./-components/services/pipeline-file-status";
import { ServiceTemplates } from "./-components/services/service-templates";

/**
 * Where "Add environment" of a service goes: the New environment page of the
 * one project that has it, with the service picked; else the projects list,
 * which says to pick one.
 */
export function addEnvironmentHref(
  service: Pick<ServiceDetail, "key" | "projects">
): string {
  const [only] = service.projects;
  return service.projects.length === 1 && only
    ? `/${only.key}/environments/new?service=${encodeURIComponent(service.key)}`
    : "/projects?newEnvironment=1";
}

// A service's page: its settings, pipeline file, notify secret, builds,
// where it is used and its variable templates. Org integration:manage, as the
// Services list.
export const Route = createFileRoute(
  "/$locale/_app/admin/services/$serviceKey"
)({
  beforeLoad: async ({ context: { queryClient } }) => {
    await requireOrgRole(queryClient, { integration: ["manage"] });
  },
  loader: async ({ params: { serviceKey }, context: { queryClient } }) => {
    await Promise.all([
      orNotFound(loaderQuery(queryClient, getServiceQuery(serviceKey))),
      orNotFound(
        loaderQuery(queryClient, listVariableTemplatesQuery(serviceKey))
      ),
    ]);
  },
  component: ServicePage,
});

function ServicePage() {
  const { serviceKey } = Route.useParams();
  const tSetup = useTranslations("setupWizard");
  const service = useSuspenseQuery(getServiceQuery(serviceKey)).data;

  return (
    <>
      <PageHeader
        title={service.key}
        subtitle={service.repoFullName}
        action={
          <Button
            nativeButton={false}
            render={<Link href={addEnvironmentHref(service)} />}
          >
            <Plus data-icon="inline-start" />
            {tSetup("addEnvironment.button")}
          </Button>
        }
      />
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <SettingsCard service={service} />
        <BuildCard service={service} />
        <UsageCard service={service} />
        <ServiceTemplates componentKey={service.key} />
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

/** Reports an API refusal as a toast; anything else propagates. */
function reportApiError(error: unknown) {
  if (error instanceof ApiError && error.status !== 401) {
    toast.error(error.message);
  } else {
    throw error;
  }
}

function SettingsCard({ service }: { service: ServiceDetail }) {
  const t = useTranslations("serviceCatalog");
  const tCommon = useTranslations("common");
  // "rotate", "commit" (every branch), or the one branch being committed.
  const [busy, setBusy] = React.useState<
    { kind: "rotate" } | { kind: "commit"; branch?: string } | null
  >(null);
  const generated = service.pipelineMode === "generated";

  async function commit(branch?: string) {
    const updated = await commitPipelineFile(service.key, branch);
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
      if (action.kind === "rotate") {
        await rotateNotifySecret(service.key);
        toast.success(t("secretRotated"));
      } else {
        await commit(action.branch);
      }
    } catch (error) {
      reportApiError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{t("settings")}</CardTitle>
          <Badge variant="outline">
            {generated ? t("modeGenerated") : t("modeCustom")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2">
          <Detail
            label={t("colRepo")}
            value={<span className="font-mono">{service.repoFullName}</span>}
          />
          <Detail label={t("colCi")} value={service.ciConnectionName ?? "—"} />
          <Detail
            label={t("ciRepoId")}
            value={<span className="font-mono">{service.ciRepoId ?? "—"}</span>}
          />
          <Detail
            label={t("bundleImage")}
            value={<span className="font-mono">{service.bundleImage}</span>}
          />
          <Detail
            label={t("notifySecretName")}
            value={
              <span className="font-mono">{service.notifySecretName}</span>
            }
          />
          <Detail
            label={t("pipelineFile")}
            value={
              <PipelineFileStatus
                component={service}
                showReason
                onRetry={(branch) => run({ kind: "commit", branch })}
                retrying={
                  busy?.kind === "commit" ? (busy.branch ?? null) : null
                }
                disabled={busy !== null}
              />
            }
          />
        </dl>
        <div className="flex flex-wrap gap-2">
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !service.ciRepoId}
                />
              }
            >
              {busy?.kind === "rotate" ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <KeyRound data-icon="inline-start" />
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
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <GitCommitHorizontal data-icon="inline-start" />
              )}
              {t("commitPipelineFile")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function BuildCard({ service }: { service: ServiceDetail }) {
  const t = useTranslations("serviceCatalog");
  const initial =
    service.lastBuild?.branch ?? service.buildSpec?.branches[0] ?? "main";
  const [branch, setBranch] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const valid = branchSchema.safeParse(branch).success;

  async function onBuild(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const { number } = await startComponentBuild(service.key, branch);
      toast.success(t("buildStarted", { number, branch }));
    } catch (error) {
      reportApiError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("build")}</CardTitle>
        <CardDescription>
          {service.lastBuild ? (
            <>
              {t("lastBuildOn", {
                tag: service.lastBuild.tag,
                branch: service.lastBuild.branch,
              })}{" "}
              <RelativeTime date={service.lastBuild.receivedAt} />
            </>
          ) : (
            t("noBuild")
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onBuild} className="flex flex-col gap-2">
          <Label htmlFor="service-build-branch">{t("buildBranch")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="service-build-branch"
              className="max-w-xs font-mono"
              autoComplete="off"
              spellCheck={false}
              value={branch}
              aria-invalid={valid ? undefined : true}
              onChange={(e) => setBranch(e.target.value.trim())}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !valid || !service.ciRepoId}
            >
              {busy ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Play data-icon="inline-start" />
              )}
              {t("startBuild")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function UsageCard({ service }: { service: ServiceDetail }) {
  const t = useTranslations("serviceCatalog");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("colUsedBy")}</CardTitle>
        <CardDescription>
          {t("usedBy", {
            projects: service.projects.length,
            environments: service.environments.length,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {service.projects.length === 0 ? (
          <p className="text-muted-foreground">{t("noProjects")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label={t("projects")}>
            {service.projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/${project.key}/settings?tab=sources`}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted"
                >
                  <span className="font-mono">{project.key}</span>
                  {project.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {service.environments.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label={t("environments")}>
            {service.environments.map((env) => (
              <li key={env.id}>
                <Link
                  href={`/${env.projectKey}/${env.slug}/deploys`}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted"
                >
                  <span className="font-mono">{env.projectKey}</span>
                  {env.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
