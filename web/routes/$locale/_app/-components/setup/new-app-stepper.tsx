import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  RegistrationFields,
  useRegistrationDraft,
} from "@/components/app-registration-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { Link, useRouter } from "@/i18n/navigation";
import { registerAppSchema } from "@/lib/ci/registration";
import {
  buildSetupInput,
  draftForHandoff,
  type EnvironmentDraft,
  emptyDraft,
  parseSetupInput,
  SETUP_DRAFT_STATE_KEY,
  SETUP_ENTRY_SERVICE_STATE_KEY,
  syncTargets,
  variableHandling,
} from "@/lib/setup/draft";
import type { SetupIssue } from "@/lib/setup/schema";
import { registerApp, triggerComponentBuild } from "@/web/api/apps";
import { ApiError } from "@/web/api/client";
import {
  createEnvironmentSetup,
  previewEnvironmentSetup,
} from "@/web/api/setup";
import {
  DatabaseSection,
  DeploySection,
  DomainSection,
  type SectionsProps,
  ServerSection,
  VariablesSection,
} from "./environment-sections";
import { SetupReview } from "./review";
import { useSetupPreview } from "./use-setup-preview";

export const NEW_APP_STEPS = [
  "repo",
  "environment",
  "database",
  "variables",
  "domain",
  "review",
] as const;
export type NewAppStep = (typeof NEW_APP_STEPS)[number];

/** The step whose inputs a setup issue's field belongs to. */
function stepOfField(field: string): NewAppStep {
  if (field.startsWith("database")) return "database";
  if (field.startsWith("variables")) return "variables";
  if (field.startsWith("domain")) return "domain";
  return "environment";
}

const LINES = ["register", "preview", "setup", "build"] as const;
type LineId = (typeof LINES)[number];
type LineState = {
  status: "idle" | "running" | "done" | "failed";
  message?: string;
};
const IDLE_LINES: Record<LineId, LineState> = {
  register: { status: "idle" },
  preview: { status: "idle" },
  setup: { status: "idle" },
  build: { status: "idle" },
};

type Registered = {
  appId: string;
  appKey: string;
  components: { componentKey: string; branch: string }[];
};
type Created = { projectKey: string; envSlug: string };

export type NewAppProject = { id: string; key: string; name: string };

const errorMessage = (error: unknown): string | null =>
  error instanceof ApiError && error.status !== 401 ? error.message : null;

/**
 * The New app page's body: Repo -> Environment -> Database -> Variables ->
 * Domain -> Review. Create runs four lines in order, each showing its own
 * result: register the app, check the setup, create it, start the first
 * build. A line that fails stops the rest; once the app is registered, the
 * lines already done are not repeated by the next Create.
 */
export function NewAppStepper({
  connections,
  projects,
  canGenerate,
  canPublish,
}: {
  connections: { id: string; name: string; hasForgeToken: boolean }[];
  /** Projects the caller may create environments in. */
  projects: NewAppProject[];
  canGenerate: boolean;
  canPublish: boolean;
}) {
  const t = useTranslations("setupWizard.newApp");
  const router = useRouter();
  const queryClient = useQueryClient();

  const registration = useRegistrationDraft(connections[0]?.id ?? "");
  const [draft, setDraft] = React.useState<EnvironmentDraft>(() =>
    emptyDraft(projects.length === 1 ? (projects[0]?.id ?? "") : "", [])
  );
  const [step, setStep] = React.useState<NewAppStep>("repo");
  const [attempted, setAttempted] = React.useState<ReadonlySet<NewAppStep>>(
    new Set()
  );
  const [registered, setRegistered] = React.useState<Registered | null>(null);
  const [created, setCreated] = React.useState<Created | null>(null);
  const [lines, setLines] = React.useState(IDLE_LINES);
  const [stopIssues, setStopIssues] = React.useState<SetupIssue[]>([]);
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false);
  const syncedBranches = React.useRef<Record<string, string>>({});

  const project = projects.find((p) => p.id === draft.projectId);
  const projectKey = project?.key ?? "";
  // The first build is of the branch the deploy target waits for.
  const targetBranch = (componentKey: string, fallback: string) =>
    draft.targets.find((t) => t.componentKey === componentKey)?.sourceBranch ||
    fallback;
  const componentRows = registration.components.map((c) => ({
    id: c.id,
    componentKey: c.componentKey.trim(),
    repoBranch: c.branch,
    branch: targetBranch(c.componentKey.trim(), c.branch),
    detection: registration.detectionOf(c.id).data,
  }));
  const entryDetection = componentRows
    .map((c) => c.detection)
    .find((d) => d?.entryService);

  const setup = useSetupPreview({
    draft,
    appId: created ? null : (registered?.appId ?? null),
    projectKey,
    entryService: entryDetection?.entryService ?? null,
  });
  const hookIssues = setup.issues;

  // Whatever the user changes invalidates what a stopped Create reported.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is the trigger
  React.useEffect(() => setStopIssues([]), [draft]);

  const issues = [...hookIssues, ...stopIssues].filter(
    (issue, i, all) =>
      all.findIndex((x) => x.field === issue.field && x.code === issue.code) ===
      i
  );
  // An issue shows on its step once the user has tried to leave the step.
  const shownByField = Object.fromEntries(
    issues
      .filter((i) => attempted.has(stepOfField(i.field)) || step === "review")
      .map((i) => [i.field, i.code])
      .reverse()
  );

  // Once the environment exists the inputs are final: only Review remains.
  const locked = created !== null;
  const finished = created !== null && lines.build.status === "done";
  useUnsavedChanges(
    (registration.dirty || draft.name !== "") && !running && !finished
  );

  function stepIssues(target: NewAppStep) {
    return issues.filter((i) => stepOfField(i.field) === target);
  }

  function goTo(next: NewAppStep) {
    if (next === "environment") {
      setDraft((d) =>
        syncTargets(
          d,
          componentRows.map((c) => ({
            componentKey: c.componentKey,
            branch: c.repoBranch,
            services: c.detection?.services.map((s) => s.name) ?? [],
          })),
          syncedBranches.current
        )
      );
      syncedBranches.current = Object.fromEntries(
        componentRows.map((c) => [c.componentKey, c.repoBranch])
      );
    }
    setStep(next);
  }

  function onNext() {
    const index = NEW_APP_STEPS.indexOf(step);
    const next = NEW_APP_STEPS[index + 1];
    if (!next) return;
    if (step === "repo") {
      if (!registration.validate()) return;
      goTo(next);
      return;
    }
    setAttempted((set) => new Set(set).add(step));
    if (stepIssues(step).length > 0) return;
    goTo(next);
  }

  function onBack() {
    const prev = NEW_APP_STEPS[NEW_APP_STEPS.indexOf(step) - 1];
    if (locked) return;
    if (prev && !(prev === "repo" && registered)) setStep(prev);
  }

  function setLine(id: LineId, state: LineState) {
    setLines((current) => ({ ...current, [id]: state }));
  }

  /** The first line that is not done runs; the rest follow while they pass. */
  async function onCreate() {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setLines((current) => ({
      register: registered ? current.register : IDLE_LINES.register,
      preview: IDLE_LINES.preview,
      setup: created ? current.setup : IDLE_LINES.setup,
      build: IDLE_LINES.build,
    }));
    try {
      let app = registered;
      if (!app) {
        const parsed = registerAppSchema.safeParse(registration.input);
        if (!parsed.success) {
          setStep("repo");
          registration.validate();
          return;
        }
        setLine("register", { status: "running" });
        try {
          const result = await registerApp(parsed.data);
          app = {
            appId: result.id,
            appKey: result.appKey,
            components: registration.components.map((c) => ({
              componentKey: c.componentKey.trim(),
              branch: targetBranch(c.componentKey.trim(), c.branch),
            })),
          };
          setRegistered(app);
          setLine("register", { status: "done" });
          toast.success(t("registered", { name: result.name }));
          for (const c of result.components) {
            for (const [branch, commit] of Object.entries(
              c.pipelineFileCommits ?? {}
            )) {
              if (commit.error) {
                toast.warning(
                  t("pipelineFileNotCommitted", {
                    component: c.componentKey,
                    branch,
                    reason: commit.error,
                  })
                );
              }
            }
          }
          // The list of apps and their components changed.
          void queryClient.invalidateQueries({ queryKey: ["apps"] });
        } catch (error) {
          const message = errorMessage(error);
          if (message === null) throw error;
          setLine("register", { status: "failed", message });
          return;
        }
      }

      let env = created;
      if (!env) {
        env = await setupEnvironment(app);
        if (!env) return;
      }

      setLine("build", { status: "running" });
      const failures: string[] = [];
      for (const c of app.components) {
        try {
          // The branch the Review shows now, not the one at registration.
          await triggerComponentBuild(
            app.appKey,
            c.componentKey,
            targetBranch(c.componentKey, c.branch)
          );
        } catch (error) {
          const message = errorMessage(error);
          if (message === null) throw error;
          failures.push(`${c.componentKey}: ${message}`);
        }
      }
      if (failures.length > 0) {
        setLine("build", { status: "failed", message: failures.join("; ") });
        return;
      }
      setLine("build", { status: "done" });
      await router.push(`/${env.projectKey}/${env.envSlug}/deploys`);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  /** Lines 2 and 3: the setup check, then the create. Null when stopped. */
  async function setupEnvironment(app: Registered): Promise<Created | null> {
    const ctx = { ...setup.draftCtx, appId: app.appId };
    const probe = parseSetupInput(
      buildSetupInput(draft, { ...ctx, probe: true }).input
    );
    setLine("preview", { status: "running" });
    if (!probe.ok) {
      setStopIssues(probe.issues);
      setLine("preview", { status: "failed", message: t("lines.hasIssues") });
      return null;
    }
    try {
      const preview = await previewEnvironmentSetup(probe.input);
      // The port the server suggests stands in for one the user left empty.
      const real = buildSetupInput(draft, {
        ...ctx,
        slug: preview.slug,
        suggestedServices: preview.suggestedServices,
        suggestedEntryPort: preview.suggestedEntryPort,
      });
      const portUnresolved = real.issues.some(
        (i) => i.field === "domain.entryPort"
      );
      const found = [
        ...real.issues,
        ...preview.issues.filter(
          (i) => !(portUnresolved && i.field === "domain.entryPort")
        ),
      ];
      const input = parseSetupInput(real.input);
      if (found.length > 0 || !input.ok) {
        setStopIssues(input.ok ? found : [...found, ...input.issues]);
        setLine("preview", { status: "failed", message: t("lines.hasIssues") });
        return null;
      }
      setLine("preview", { status: "done" });

      setLine("setup", { status: "running" });
      const result = await createEnvironmentSetup(input.input);
      if (result.provisioningError) {
        toast.warning(t("provisioningNotStarted"));
      }
      const env = { projectKey: result.projectKey, envSlug: result.envSlug };
      setCreated(env);
      setLine("setup", { status: "done" });
      return env;
    } catch (error) {
      const message = errorMessage(error);
      if (message === null) throw error;
      setLines((current) => {
        const failed: LineId =
          current.preview.status === "running" ? "preview" : "setup";
        return { ...current, [failed]: { status: "failed", message } };
      });
      return null;
    }
  }

  const sectionProps: SectionsProps = {
    draft,
    onChange: (update) => setDraft(update),
    draftCtx: setup.draftCtx,
    options: setup.options,
    databaseHosts: setup.databaseHosts,
    policies: setup.policiesQuery.data,
    policiesFailed: setup.policiesQuery.isError,
    canPublish,
    issues: shownByField,
  };
  const setupFailed =
    registered !== null &&
    created === null &&
    (lines.preview.status === "failed" || lines.setup.status === "failed");

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <StepIndicator
        step={step}
        locked={registered ? "repo" : null}
        allLocked={locked}
        onSelect={(target) => {
          if (locked) return;
          if (NEW_APP_STEPS.indexOf(target) < NEW_APP_STEPS.indexOf(step)) {
            setStep(target);
          }
        }}
      />

      {step === "repo" && (
        <RegistrationFields
          draft={registration}
          connections={connections}
          canGenerate={canGenerate}
        />
      )}

      {step === "environment" && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4">
              <Field data-invalid={shownByField.projectId ? true : undefined}>
                <FieldLabel htmlFor="env-project">
                  {t("environment.project")}
                </FieldLabel>
                <FieldContent>
                  <Select
                    value={draft.projectId || null}
                    onValueChange={(value) =>
                      setDraft((d) => ({
                        ...d,
                        projectId: value ?? "",
                        serverId: "",
                      }))
                    }
                    disabled={projects.length === 0}
                  >
                    <SelectTrigger
                      id="env-project"
                      aria-label={t("environment.project")}
                    >
                      <SelectValue
                        placeholder={t("environment.projectPlaceholder")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {shownByField.projectId && (
                    <FieldError>
                      {setup.message(shownByField.projectId)}
                    </FieldError>
                  )}
                </FieldContent>
              </Field>
              <Field data-invalid={shownByField.name ? true : undefined}>
                <FieldLabel htmlFor="env-name">
                  {t("environment.name")}
                </FieldLabel>
                <FieldContent>
                  <Input
                    id="env-name"
                    autoComplete="off"
                    placeholder={t("environment.namePlaceholder")}
                    value={draft.name}
                    aria-invalid={shownByField.name ? true : undefined}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, name: e.target.value }))
                    }
                  />
                  {shownByField.name && (
                    <FieldError>{setup.message(shownByField.name)}</FieldError>
                  )}
                </FieldContent>
              </Field>
            </CardContent>
          </Card>
          <div className="flex flex-col gap-3">
            <ServerSection {...sectionProps} defaultOpen />
            <DeploySection {...sectionProps} defaultOpen />
          </div>
        </>
      )}

      {step === "database" && <DatabaseSection {...sectionProps} defaultOpen />}

      {step === "variables" && (
        <>
          <p className="text-sm text-muted-foreground">{t("variables.hint")}</p>
          <VariablesSection {...sectionProps} defaultOpen />
        </>
      )}

      {step === "domain" && (
        <>
          {entryDetection?.entryService && (
            <Alert>
              <AlertDescription>
                {entryDetection.entryContainerPort === null
                  ? t("domain.entryService", {
                      service: entryDetection.entryService,
                    })
                  : t("domain.entryDetected", {
                      service: entryDetection.entryService,
                      port: entryDetection.entryContainerPort,
                    })}
              </AlertDescription>
            </Alert>
          )}
          <DomainSection {...sectionProps} defaultOpen />
        </>
      )}

      {step === "review" && (
        <ReviewStep
          draft={draft}
          setup={setup}
          registered={registered}
          appKey={registration.appKey.trim()}
          componentRows={componentRows}
          issues={issues}
          projectKey={projectKey}
          running={running}
          lines={lines}
          setupFailed={setupFailed}
          created={created}
          entryService={entryDetection?.entryService ?? null}
          onCreate={onCreate}
        />
      )}

      {step !== "review" && (
        <div className="flex justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => (step === "repo" ? router.push("/apps") : onBack())}
          >
            {step === "repo" ? t("cancel") : t("back")}
          </Button>
          <Button type="button" onClick={onNext}>
            {t("next")}
          </Button>
        </div>
      )}
      {step === "review" && !running && !locked && (
        <div className="flex justify-start">
          <Button type="button" variant="ghost" onClick={onBack}>
            {t("back")}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepIndicator({
  step,
  locked,
  allLocked,
  onSelect,
}: {
  step: NewAppStep;
  /** A step that can no longer be visited (the app is registered). */
  locked: NewAppStep | null;
  /** The environment exists: no step can be revisited. */
  allLocked: boolean;
  onSelect: (step: NewAppStep) => void;
}) {
  const t = useTranslations("setupWizard.newApp");
  const current = NEW_APP_STEPS.indexOf(step);
  return (
    <nav aria-label={t("steps.label")}>
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {NEW_APP_STEPS.map((name, index) => (
          <li key={name} className="flex items-center gap-2">
            <button
              type="button"
              disabled={allLocked || index >= current || name === locked}
              aria-current={index === current ? "step" : undefined}
              onClick={() => onSelect(name)}
              className={
                index === current
                  ? "font-medium text-foreground"
                  : "text-muted-foreground enabled:hover:text-foreground"
              }
            >
              {index + 1}. {t(`steps.${name}`)}
            </button>
            {index < NEW_APP_STEPS.length - 1 && (
              <span className="text-muted-foreground" aria-hidden="true">
                /
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function ReviewStep({
  draft,
  setup,
  registered,
  appKey,
  componentRows,
  issues,
  projectKey,
  running,
  lines,
  setupFailed,
  created,
  entryService,
  onCreate,
}: {
  draft: EnvironmentDraft;
  setup: ReturnType<typeof useSetupPreview>;
  registered: Registered | null;
  appKey: string;
  componentRows: { componentKey: string; branch: string }[];
  issues: SetupIssue[];
  projectKey: string;
  running: boolean;
  lines: Record<LineId, LineState>;
  setupFailed: boolean;
  created: Created | null;
  entryService: string | null;
  onCreate: () => void;
}) {
  const t = useTranslations("setupWizard.newApp");
  const tr = useTranslations("setupWizard.newApp.review");
  const multiple = componentRows.length > 1;
  const buildLines = componentRows.map((c) =>
    multiple
      ? tr("startBuildOf", { branch: c.branch, component: c.componentKey })
      : tr("startBuild", { branch: c.branch })
  );
  // Before the app exists the server cannot preview (it needs the app), so
  // the lines come from the draft; afterwards the preview's own lines.
  const setupLines = setup.preview
    ? setup.preview.creates
    : summaryLines(draft, setup, tr);
  const creates = [tr("register", { appKey }), ...setupLines, ...buildLines];
  const buildFailed = lines.build.status === "failed";

  return (
    <SetupReview
      creates={creates}
      plan={setup.preview?.plan ?? []}
      lookups={setup.lookups}
      issues={issues}
      projectKey={projectKey}
      checking={registered !== null && setup.checking}
      previewFailed={registered !== null && setup.previewFailed}
      onRetry={() => setup.previewQuery.refetch()}
      submitting={running}
      onSubmit={onCreate}
    >
      <section className="flex flex-col gap-2" aria-label={t("progress.title")}>
        <h3 className="text-sm font-medium">{t("progress.title")}</h3>
        <ol className="flex flex-col gap-1.5 text-sm">
          {LINES.map((id) => (
            <ProgressLine key={id} id={id} state={lines[id]} />
          ))}
        </ol>
      </section>

      {registered && setupFailed && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="flex flex-col gap-2">
            <span>{t("setupFailed", { appKey: registered.appKey })}</span>
            <Link
              className="font-medium underline underline-offset-4"
              href={`/apps/${registered.appKey}/environments/new${
                projectKey ? `?project=${projectKey}` : ""
              }`}
              state={{
                [SETUP_DRAFT_STATE_KEY]: draftForHandoff(draft),
                ...(entryService
                  ? { [SETUP_ENTRY_SERVICE_STATE_KEY]: entryService }
                  : {}),
              }}
            >
              {t("addEnvironmentLink")}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {created && buildFailed && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="flex flex-col gap-2">
            <span>{t("buildFailed")}</span>
            <Link
              className="font-medium underline underline-offset-4"
              href={`/${created.projectKey}/${created.envSlug}/deploys`}
            >
              {t("openDeploys")}
            </Link>
          </AlertDescription>
        </Alert>
      )}
    </SetupReview>
  );
}

function ProgressLine({ id, state }: { id: LineId; state: LineState }) {
  const t = useTranslations("setupWizard.newApp");
  return (
    <li className="flex items-start gap-2" data-status={state.status}>
      {state.status === "running" ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
      ) : state.status === "done" ? (
        <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : state.status === "failed" ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <span className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      )}
      <span className={state.status === "failed" ? "text-destructive" : ""}>
        {t(`lines.${id}`)}
        {": "}
        {t(`lineStatus.${state.status}`)}
        {state.message ? ` — ${state.message}` : ""}
      </span>
    </li>
  );
}

/** What the draft will create, in the Review's words, before the preview. */
function summaryLines(
  draft: EnvironmentDraft,
  setup: ReturnType<typeof useSetupPreview>,
  t: ReturnType<typeof useTranslations<"setupWizard.newApp.review">>
): string[] {
  const out: string[] = [];
  const server = setup.options?.servers.find((s) => s.id === draft.serverId);
  out.push(t("environment", { name: draft.name }));
  for (const target of draft.targets) {
    out.push(
      t("target", {
        component: target.componentKey,
        branch: target.sourceBranch,
        server: server?.name ?? "-",
      })
    );
  }
  out.push(t(`database.${draft.database.kind}`));
  const generated = draft.variables.filter(
    (v) => variableHandling(v) === "generate"
  ).length;
  out.push(t("variables", { count: draft.variables.length, generated }));
  out.push(
    draft.domain.kind === "tunnel"
      ? t("domain.tunnel", {
          host: `${draft.domain.label ?? setup.draftCtx.slug}`,
        })
      : draft.domain.kind === "external"
        ? t("domain.external", { host: draft.domain.hostname })
        : t("domain.none")
  );
  return out;
}
