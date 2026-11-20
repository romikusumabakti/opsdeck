import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  defaultSpec,
  specDraftOf,
  toSpec,
} from "@/components/app-registration-fields";
import { SearchSelect } from "@/components/search-select";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import { repoRepresentative } from "@/lib/ci/registration";
import {
  buildSetupInput,
  type DraftContext,
  draftFromSetup,
  type EnvironmentDraft,
  effectiveServices,
  issuesByField,
  repoKeyOf,
} from "@/lib/setup/draft";
import { isSetupIssueCode } from "@/lib/setup/issues";
import type {
  NewEnvironmentInput,
  NewEnvironmentPlan,
} from "@/lib/setup/new-environment";
import {
  changedSince,
  dedupe,
  type FormGroup,
  type FormSnapshot,
  fieldOfCode,
  groupOf,
  parseNewEnvironmentInput,
  snapshotOf,
  visibleIssues,
} from "@/lib/setup/new-environment-form-state";
import type { SetupIssue } from "@/lib/setup/schema";
import { sectionOfField } from "@/lib/setup/sections";
import { baseEnvSlug } from "@/lib/setup/slug";
import { initialRepoBranch } from "@/lib/setup/source-branch";
import { ApiError } from "@/web/api/client";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import {
  copySourceQuery,
  createNewEnvironment,
  type NewEnvironmentPreview,
  previewNewEnvironment,
  setupAccessPoliciesQuery,
  setupOptionsQuery,
  setupReposQuery,
} from "@/web/api/setup";
import { listAssignableUsersQuery } from "@/web/api/users";
import type { ProvisioningLookups } from "../env/provisioning-step-sentence";
import { useEnvSlugCheck } from "../env/use-env-slug-check";
import {
  DatabaseSection,
  DeploySection,
  DomainSection,
  type SectionsProps,
  ServerSection,
  VariablesSection,
} from "./environment-sections";
import { type EnvKind, KindOwnerFields } from "./kind-owner-fields";
import {
  type PipelineChoice,
  PipelineChoices,
  type PipelineRepo,
} from "./pipeline-choices";
import { RepoListRow, ServiceListRow } from "./repo-list-row";
import { RepoPicker } from "./repo-picker";
import { SetupReview } from "./review";
import { ServicePicker } from "./service-picker";
import type { NewEnvironmentSources } from "./sources-mode";
import { useApiErrorMessage, useIssueMessage } from "./use-issue-message";

// The New environment page (inside a project): Start from, Name, Services
// (any subset of the project's services, and repositories to register as new
// ones), "Needs a database", Address and Create, with the rest under Advanced
// options. The server resolves the short input (POST
// /api/setup/new-environment/preview); the check runs only on Create, when
// Advanced options opens and when a repository is picked, never per key.
// Which issues show is lib/setup/new-environment-form-state's rule.

export type NewEnvironmentProject = {
  id: string;
  key: string;
  defaultServerId: string | null;
  environments: { id: string; name: string }[];
};

/** A registered service the environment may deploy. */
export type NewEnvironmentService = {
  componentKey: string;
  ciConnectionId: string;
  repoFullName: string;
  buildSpec?: { branches: string[]; artifact?: unknown } | null;
};

/** A repository no service builds yet: the create registers it. */
type RepoRow = {
  ciConnectionId: string;
  repoFullName: string;
  branch: string;
};

/** A registered service the environment deploys, on its branch. */
type PickedService = { componentKey: string; branch: string };

/** What the environment deploys: registered services and new repositories. */
type Selection = { services: PickedService[]; repos: RepoRow[] };

const NOTHING: Selection = { services: [], repos: [] };

/** The Advanced sections whose values replace the resolved ones once edited. */
type AdvancedKey = "targets" | "services" | "database" | "variables" | "domain";

const NEW = "__new";
const ENTRY_PORT_VARIABLE = "ENTRY_PORT";
/** Lets the preview run (detection on pick) before a name is typed. */
const PROBE_NAME = "new";

type Checked = {
  snapshot: FormSnapshot;
  /** Ran with PROBE_NAME: its summary is not this environment's. */
  probe: boolean;
  plan: NewEnvironmentPlan | null;
  preview: NewEnvironmentPreview["preview"];
  issues: SetupIssue[];
};

function withoutKeys(
  set: ReadonlySet<AdvancedKey>,
  ...keys: AdvancedKey[]
): ReadonlySet<AdvancedKey> {
  const next = new Set(set);
  for (const key of keys) next.delete(key);
  return next;
}

export function NewEnvironmentForm({
  project,
  services,
  canPublish,
  canChoosePipelines,
  initialFrom,
  initialRepo,
  initialService,
  sources = null,
}: {
  project: NewEnvironmentProject;
  /** The registered services (only the project's, when it has sources): their repositories and branches. */
  services: NewEnvironmentService[];
  /** May put an address behind no policy (org server:manage). */
  canPublish: boolean;
  /** May choose a new repository's pipeline (org integration:manage). */
  canChoosePipelines: boolean;
  /** `?from=`: the environment to copy. */
  initialFrom?: string;
  /** `?repo=`: the repository to start with. */
  initialRepo?: string;
  /** `?service=`: the service to start with. */
  initialService?: string;
  /** The project's sources; null (no sources) keeps every service pickable. */
  sources?: NewEnvironmentSources | null;
}) {
  const t = useTranslations("newEnvironment");
  const tSetup = useTranslations("setup");
  const tWizard = useTranslations("setupWizard");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const message = useIssueMessage(project.key);
  const errorMessage = useApiErrorMessage(project.key);

  const components = services;
  // For a repository building several, its non-artifact service.
  const componentOfRepo = (repoFullName: string) =>
    repoRepresentative(
      components.filter((c) => c.repoFullName === repoFullName)
    );
  const startComponent = initialService
    ? components.find((c) => c.componentKey === initialService)
    : initialRepo
      ? componentOfRepo(initialRepo)
      : undefined;
  // A component picked without a copy source starts on the project default
  // branch, else its build spec's first branch, the repository's, "main".
  const startBranch = (
    component:
      | { componentKey: string; buildSpec?: { branches: string[] } | null }
      | undefined,
    repoDefault?: string
  ) =>
    initialRepoBranch({
      projectDefault: component
        ? sources?.defaultBranches[component.componentKey]
        : null,
      specBranches: component?.buildSpec?.branches,
      repoDefault,
    });

  // Copy sources: any environment of the project, newest first (uuidv7 ids
  // sort by creation). A copy keeps the settings of the services both share.
  const copySources = [...project.environments].sort((a, b) =>
    b.id.localeCompare(a.id)
  );
  const defaultFrom =
    initialFrom ??
    (initialRepo || initialService ? undefined : copySources[0]?.id) ??
    null;

  const [startFrom, setStartFrom] = React.useState<string | null>(defaultFrom);
  const [name, setName] = React.useState("");
  // The URL name as typed; empty = the default the name gives.
  const [slug, setSlug] = React.useState("");
  const [selection, setSelection] = React.useState<Selection>(() =>
    !defaultFrom && startComponent
      ? {
          services: [
            {
              componentKey: startComponent.componentKey,
              branch: startBranch(startComponent),
            },
          ],
          repos: [],
        }
      : NOTHING
  );
  const { services: picked, repos } = selection;
  const [needsDatabase, setNeedsDatabase] = React.useState(false);
  const [address, setAddress] = React.useState<{ label: string } | null>({
    label: "",
  });
  const [serverId, setServerId] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<EnvKind | null | undefined>();
  const [ownerId, setOwnerId] = React.useState<string | null | undefined>();
  const [pipelines, setPipelines] = React.useState<
    Record<string, PipelineChoice>
  >({});
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [advanced, setAdvanced] = React.useState<EnvironmentDraft | null>(null);
  const [edited, setEditedState] = React.useState<ReadonlySet<AdvancedKey>>(
    new Set()
  );
  // A check's answer seeds the sections not edited by then: the ref, not the
  // state of the render that started the check.
  const editedRef = React.useRef(edited);
  const setEdited = (
    update: (prev: ReadonlySet<AdvancedKey>) => ReadonlySet<AdvancedKey>
  ) => {
    editedRef.current = update(editedRef.current);
    setEditedState(editedRef.current);
  };
  const [touched, setTouched] = React.useState<ReadonlySet<FormGroup>>(
    new Set()
  );
  const [submitted, setSubmitted] = React.useState(false);
  const [checked, setChecked] = React.useState<Checked | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [checkFailed, setCheckFailed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [created, setCreated] = React.useState(false);
  const requestId = React.useRef(0);

  const touch = (group: FormGroup) =>
    setTouched((prev) => (prev.has(group) ? prev : new Set(prev).add(group)));

  const options = useQuery(setupOptionsQuery(project.id)).data;
  const slugCheck = useEnvSlugCheck(project.id, slug || null);
  const databaseHosts = useQuery(listDatabaseHostsQuery()).data ?? [];
  const plan = checked?.plan ?? null;
  // The policies name the address's policy (after a check) and fill the
  // Advanced domain section; reading them calls Cloudflare.
  const planDomain = plan?.setup.domain;
  const policiesQuery = useQuery({
    ...setupAccessPoliciesQuery(project.id),
    enabled:
      planDomain?.kind === "tunnel" ||
      (advancedOpen && advanced?.domain.kind === "tunnel"),
    retry: false,
  });
  const owners = useQuery({
    ...listAssignableUsersQuery(project.id),
    enabled: advancedOpen,
  }).data;

  // The copy source fills the services, branches, database choice and
  // address once per source.
  const sourceQuery = useQuery({
    ...copySourceQuery(startFrom ?? ""),
    enabled: startFrom !== null,
  });
  const source = startFrom ? sourceQuery.data : undefined;
  const sourceServices = React.useMemo<PickedService[]>(
    () =>
      (source?.targets ?? []).flatMap((target) =>
        components.some((x) => x.componentKey === target.componentKey)
          ? [{ componentKey: target.componentKey, branch: target.sourceBranch }]
          : []
      ),
    [source, components]
  );
  const appliedSource = React.useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: setEdited writes a ref and state only
  React.useEffect(() => {
    if (!source || appliedSource.current === source.environment.id) return;
    appliedSource.current = source.environment.id;
    setSelection({ services: sourceServices, repos: [] });
    setEdited((prev) => withoutKeys(prev, "targets", "services"));
    setNeedsDatabase(source.database.kind !== "none");
    setAddress(source.domain.kind === "none" ? null : { label: "" });
  }, [source, sourceServices]);

  // `?repo=` of a repository no service builds yet: its CI connection and
  // main branch come from the repository search, once.
  const [pendingRepo, setPendingRepo] = React.useState(
    initialRepo && !startComponent ? initialRepo : null
  );
  const pendingRepoRows = useQuery({
    ...setupReposQuery(pendingRepo ?? ""),
    enabled: pendingRepo !== null,
  }).data;
  React.useEffect(() => {
    if (!pendingRepoRows) return;
    const row = pendingRepoRows.find((r) => r.repoFullName === pendingRepo);
    setPendingRepo(null);
    if (row && !row.componentKey) {
      setSelection({
        services: [],
        repos: [
          {
            ciConnectionId: row.ciConnectionId,
            repoFullName: row.repoFullName,
            branch: row.defaultBranch,
          },
        ],
      });
    }
  }, [pendingRepoRows, pendingRepo]);

  // The input: a copy whose services and branches are the source's sends
  // none (the server takes the source's services).
  const sameAsSource =
    startFrom !== null &&
    repos.length === 0 &&
    picked.length === sourceServices.length &&
    picked.every(
      (p, i) =>
        p.componentKey === sourceServices[i]?.componentKey &&
        p.branch === sourceServices[i]?.branch
    );
  // The URL name the server gives when none is typed: the last check's for
  // this name (it skips slugs the project uses, e.g. `qa-2`), else the
  // name's own until a check runs.
  const checkedSlug =
    checked &&
    !checked.probe &&
    checked.snapshot.name === name.trim() &&
    checked.snapshot.slug === ""
      ? checked.preview?.slug
      : undefined;
  const defaultSlug = checkedSlug ?? baseEnvSlug(name || PROBE_NAME);
  const draftCtx: DraftContext = {
    // Services of one repository share a default deploy dir.
    repoOf: Object.fromEntries([
      ...components.map((c) => [
        c.componentKey,
        repoKeyOf(c.ciConnectionId, c.repoFullName),
      ]),
      ...(plan?.registrations ?? []).map((r) => [
        r.componentKey,
        repoKeyOf(r.ciConnectionId, r.repoFullName),
      ]),
    ]),
    projectKey: project.key,
    slug: slug || defaultSlug,
    suggestedServices: [],
    suggestedEntryPort: plan?.summary.port ?? null,
    defaultZoneId: options?.zones[0]?.id ?? "",
    entryService: plan?.setup.entryService ?? null,
  };

  // The admin's pipeline choices, for the repositories still to register.
  const unregistered = repos;
  const chosenPipelines = canChoosePipelines
    ? unregistered.flatMap((r) => {
        const choice = pipelines[r.repoFullName];
        return choice
          ? [
              {
                repoFullName: r.repoFullName,
                mode: choice.mode,
                ...(choice.mode === "generated"
                  ? { buildSpec: toSpec(choice.spec) }
                  : {}),
              },
            ]
          : [];
      })
    : [];

  function advancedInput(): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    if (kind !== undefined) out.kind = kind;
    if (ownerId !== undefined) out.ownerId = ownerId;
    if (chosenPipelines.length > 0) out.pipelines = chosenPipelines;
    if (advanced) {
      const built = buildSetupInput(advanced, draftCtx).input as Record<
        string,
        unknown
      >;
      if (edited.has("targets")) out.targets = built.targets;
      if (edited.has("services")) {
        out.services = effectiveServices(advanced, draftCtx);
      }
      if (edited.has("variables")) out.variables = built.variables;
      if (edited.has("domain")) out.domain = built.domain;
      if (edited.has("database")) {
        const db = advanced.database;
        // Left-out names are the server's defaults; the role follows the
        // database name until it is edited itself.
        out.database =
          db.kind === "shared"
            ? {
                kind: "shared",
                databaseHostId: db.databaseHostId || undefined,
                dbName: db.dbName ?? undefined,
                dbRole: db.dbRole ?? undefined,
                passwordVariable: db.passwordVariable || undefined,
              }
            : db.kind === "container"
              ? { kind: "container", serviceName: db.serviceName ?? undefined }
              : { kind: db.kind };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function rawInput(nameValue: string) {
    return {
      projectId: project.id,
      name: nameValue,
      ...(slug ? { slug } : {}),
      copyFromEnvironmentId: startFrom,
      services: sameAsSource ? [] : picked,
      repos: sameAsSource
        ? []
        : repos.map(({ ciConnectionId, repoFullName, branch }) => ({
            ciConnectionId,
            repoFullName,
            branch,
          })),
      needsDatabase,
      address,
      ...(serverId ? { serverId } : {}),
      advanced: advancedInput(),
    };
  }

  const parsed = parseNewEnvironmentInput(rawInput(name));
  // What a check would send now (a name filled in when none is typed).
  const probing = name.trim() === "";
  const checkable = probing
    ? parseNewEnvironmentInput(rawInput(PROBE_NAME))
    : parsed;
  // What a check now would be about: with no name typed, the probe's (a
  // repository picked first still shows its detection and issues).
  const snapshot = checkable.ok ? snapshotOf(checkable.input) : null;

  /**
   * Resolves an input on the server. A stale answer (another check started
   * since) is dropped. Advanced sections not edited follow the plan.
   */
  async function check(
    input: NewEnvironmentInput,
    probe: boolean
  ): Promise<Checked | null> {
    const id = ++requestId.current;
    setChecking(true);
    setCheckFailed(false);
    try {
      const answer = await previewNewEnvironment(input);
      if (id !== requestId.current) return null;
      const issues = dedupe([
        ...answer.plan.issues,
        ...(answer.preview?.issues ?? []),
      ]);
      const result: Checked = {
        snapshot: snapshotOf(input),
        probe,
        plan: answer.plan,
        preview: answer.preview,
        issues,
      };
      setChecked(result);
      const seeded = draftFromSetup(answer.plan.setup, issues);
      seeded.variables = seeded.variables.filter(
        (v) => v.name !== ENTRY_PORT_VARIABLE
      );
      setAdvanced((prev) => {
        if (!prev) return seeded;
        const kept = editedRef.current;
        return {
          ...prev,
          serverId: seeded.serverId,
          targets: kept.has("targets") ? prev.targets : seeded.targets,
          serviceNames: kept.has("services")
            ? prev.serviceNames
            : seeded.serviceNames,
          database: kept.has("database") ? prev.database : seeded.database,
          variables: kept.has("variables") ? prev.variables : seeded.variables,
          domain: kept.has("domain") ? prev.domain : seeded.domain,
        };
      });
      return result;
    } catch (error) {
      if (id !== requestId.current) return null;
      // A coded refusal (a repository Menara cannot read, the CI server
      // down) is an issue of its field; anything else leaves the check open.
      if (
        error instanceof ApiError &&
        error.code &&
        isSetupIssueCode(error.code)
      ) {
        const result: Checked = {
          snapshot: snapshotOf(input),
          probe,
          plan: null,
          preview: null,
          issues: [{ field: fieldOfCode(error.code), code: error.code }],
        };
        setChecked(result);
        return result;
      }
      setCheckFailed(true);
      return null;
    } finally {
      if (id === requestId.current) setChecking(false);
    }
  }

  /** A check of what the page shows now, when it parses. */
  function checkNow() {
    if (created || !checkable.ok) return;
    void check(checkable.input, probing);
  }

  // A picked repository runs the check (detection) once the state has
  // settled; so does an open Advanced panel still waiting for a valid input.
  const [checkRequest, setCheckRequest] = React.useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on request only (checkRequest), with that render's state
  React.useEffect(() => {
    if (checkRequest > 0) checkNow();
  }, [checkRequest]);
  const checkableNow = checkable.ok;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-checks once the input is fixed
  React.useEffect(() => {
    if (advancedOpen && !advanced && checkableNow && !checking) checkNow();
  }, [checkableNow]);

  function changeSelection(
    update: (selection: Selection) => Selection,
    recheck = true
  ) {
    touch("repos");
    setSelection(update);
    setEdited((prev) => withoutKeys(prev, "targets", "services"));
    if (recheck) setCheckRequest((n) => n + 1);
  }
  function addService(componentKey: string, repoDefault?: string) {
    const component = components.find((c) => c.componentKey === componentKey);
    const branch = startBranch(component, repoDefault);
    changeSelection((sel) =>
      sel.services.some((p) => p.componentKey === componentKey)
        ? sel
        : { ...sel, services: [...sel.services, { componentKey, branch }] }
    );
  }
  // A registered repository adds its service; another one is registered.
  function addRepo(row: {
    ciConnectionId: string;
    repoFullName: string;
    componentKey: string | null;
    defaultBranch?: string;
  }) {
    if (row.componentKey) {
      addService(row.componentKey, row.defaultBranch);
      return;
    }
    const branch = startBranch(undefined, row.defaultBranch);
    changeSelection((sel) =>
      sel.repos.some((r) => r.repoFullName === row.repoFullName)
        ? sel
        : {
            ...sel,
            repos: [
              ...sel.repos,
              {
                ciConnectionId: row.ciConnectionId,
                repoFullName: row.repoFullName,
                branch,
              },
            ],
          }
    );
  }
  // The repositories the repository search must not offer again: the new
  // ones, and those whose service (the search's) is picked.
  const pickedKeys = new Set(picked.map((p) => p.componentKey));
  const pickedRepos = [
    ...repos.map((r) => r.repoFullName),
    ...components
      .filter(
        (c) =>
          pickedKeys.has(c.componentKey) &&
          componentOfRepo(c.repoFullName)?.componentKey === c.componentKey
      )
      .map((c) => c.repoFullName),
  ];

  function onAdvancedOpenChange(open: boolean) {
    setAdvancedOpen(open);
    if (open) checkNow();
  }

  function onAdvancedChange(
    update: (draft: EnvironmentDraft) => EnvironmentDraft
  ) {
    if (!advanced) return;
    const next = update(advanced);
    touch("advanced");
    setEdited((prev) => {
      const changed = new Set(prev);
      if (next.targets !== advanced.targets) changed.add("targets");
      if (next.serviceNames !== advanced.serviceNames) changed.add("services");
      if (next.database !== advanced.database) changed.add("database");
      if (next.variables !== advanced.variables) changed.add("variables");
      if (next.domain !== advanced.domain) changed.add("domain");
      return changed;
    });
    if (next.serverId !== advanced.serverId) {
      touch("server");
      setServerId(next.serverId || null);
    }
    setAdvanced(next);
  }

  async function onCreate() {
    if (created || submitting) return;
    setSubmitted(true);
    if (!parsed.ok || probing) return;
    const input = parsed.input;
    const key = JSON.stringify(snapshotOf(input));
    const current =
      checked && !checked.probe && JSON.stringify(checked.snapshot) === key
        ? checked
        : await check(input, false);
    if (!current || current.issues.length > 0) return;
    setSubmitting(true);
    try {
      const result = await createNewEnvironment(input);
      setCreated(true);
      toast.success(t("created"));
      if (result.provisioningError) toast.warning(t("provisioningNotStarted"));
      for (const failure of result.pipelineFileFailures) {
        toast.warning(
          t("pipelineFileNotCommitted", {
            branch: failure.branch,
            component: failure.componentKey,
          })
        );
      }
      if (result.buildFailures.length > 0) toast.warning(t("buildNotStarted"));
      router.push(`/${result.projectKey}/${result.envSlug}/deploys`);
    } catch (error) {
      const text = errorMessage(error);
      if (text === null) throw error;
      if (
        error instanceof ApiError &&
        error.code &&
        isSetupIssueCode(error.code)
      ) {
        // The world moved on (a name taken meanwhile): shown at its field.
        setChecked({
          ...current,
          issues: [{ field: fieldOfCode(error.code), code: error.code }],
        });
      } else {
        toast.error(text);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const noServerKnown =
    options !== undefined &&
    options.servers.length === 0 &&
    !project.defaultServerId;
  const clientIssues: SetupIssue[] = [
    ...(probing ? [{ field: "name", code: "required" }] : []),
    ...(parsed.ok ? [] : parsed.issues.filter((i) => i.field !== "name")),
  ];
  const issues = visibleIssues({
    clientIssues,
    checkIssues: (checked?.issues ?? []).filter(
      (i) => !(checked?.probe && groupOf(i.field) === "name")
    ),
    snapshot,
    checked: checked?.snapshot ?? null,
    submitted,
    touched,
    noServerKnown,
  });
  const byField = issuesByField(issues);
  const noServer = issues.some((i) => i.code === "noServerAvailable");
  const firstOf = (group: FormGroup) =>
    issues.find((i) => groupOf(i.field) === group);
  const checkIsCurrent = (group: FormGroup) =>
    !changedSince(snapshot, checked?.snapshot ?? null, group);

  const showSummary =
    plan !== null && !checked?.probe && checkIsCurrent("name") && !noServer;
  const zones = options?.zones ?? [];
  const zoneName = (
    zones.find(
      (z) => planDomain?.kind === "tunnel" && z.id === planDomain.zoneId
    ) ?? zones[0]
  )?.name;
  const policyName =
    planDomain?.kind === "tunnel"
      ? policiesQuery.data?.find((p) => p.id === planDomain.accessPolicyId)
          ?.name
      : undefined;
  const showServerPicker = !project.defaultServerId && !noServer;

  const lookups = React.useMemo<ProvisioningLookups>(() => {
    const servers = new Map(
      (options?.servers ?? []).map((s) => [s.id, `${s.name} (${s.host})`])
    );
    const tunnels = new Map(
      (options?.tunnels ?? []).map((x) => [x.id, x.name])
    );
    const policies = new Map(
      (policiesQuery.data ?? []).map((p) => [p.id, p.name])
    );
    return {
      serverLabel: (id) => servers.get(id),
      databaseHost: (id) => databaseHosts.find((h) => h.id === id),
      componentKey: (id) => id,
      tunnelName: (id) => tunnels.get(id),
      policyName: (id) => policies.get(id),
    };
  }, [options, databaseHosts, policiesQuery.data]);

  const sectionsProps: SectionsProps | null = advanced
    ? {
        draft: advanced,
        onChange: onAdvancedChange,
        draftCtx,
        options,
        databaseHosts,
        policies: policiesQuery.data,
        policiesFailed: policiesQuery.isError,
        canPublish,
        issues: byField,
      }
    : null;

  // The repositories the create registers, with the pipeline in effect.
  const pipelineRepos: PipelineRepo[] = canChoosePipelines
    ? unregistered.flatMap((r) => {
        const registration = plan?.registrations.find(
          (x) => x.repoFullName === r.repoFullName
        );
        const componentKey = registration?.componentKey;
        if (!componentKey) return [];
        const index = chosenPipelines.findIndex(
          (p) => p.repoFullName === r.repoFullName
        );
        const detected: PipelineChoice = {
          mode: registration.pipelineMode,
          spec: registration.buildSpec
            ? specDraftOf(registration.buildSpec)
            : { ...defaultSpec(componentKey), branches: r.branch },
        };
        return [
          {
            repoFullName: r.repoFullName,
            componentKey,
            choice: pipelines[r.repoFullName] ?? detected,
            index: index === -1 ? null : index,
          },
        ];
      })
    : [];

  const detectionPlan = checkIsCurrent("repos") ? plan : null;

  /** The label of the field an issue is about, as the page shows it. */
  function fieldLabel(field: string): string {
    switch (groupOf(field)) {
      case "startFrom":
        return t("startFrom");
      case "name":
        return t("name");
      case "slug":
        return t("slug");
      case "repos":
        return t("services");
      case "address":
        return t("address");
      case "server":
        return t("server");
      default:
        return tWizard(`sections.${sectionOfField(field) ?? "general"}`);
    }
  }

  const nameIssue = byField.name;
  // The live check while typing, else the last check's (a create refused).
  const slugIssue = slugCheck.code ?? byField.slug;
  const reposIssue = byField.repos ?? byField.targets;
  const databaseIssue = firstOf("database");
  const addressIssue = firstOf("address");
  const serverIssue = byField.serverId ?? byField["server.serverId"];

  // `?from=` may name an environment of another project: list it too
  // (labelled "Loading…" until its name arrives).
  const outsideSourceName =
    startFrom && !copySources.some((e) => e.id === startFrom)
      ? (sourceQuery.data?.environment.name ?? null)
      : undefined;
  const startFromOptions = [
    { value: NEW, label: t("startFromNew") },
    ...copySources.map((e) => ({
      value: e.id,
      label: t("startFromCopy", { name: e.name }),
    })),
    ...(startFrom && outsideSourceName !== undefined
      ? [
          {
            value: startFrom,
            label:
              outsideSourceName === null
                ? tCommon("loading")
                : t("startFromCopy", { name: outsideSourceName }),
          },
        ]
      : []),
  ];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor="env-start-from">{t("startFrom")}</FieldLabel>
            <FieldContent>
              <SearchSelect
                id="env-start-from"
                aria-label={t("startFrom")}
                value={startFrom ?? NEW}
                onChange={(value) => {
                  const next = value && value !== NEW ? value : null;
                  touch("startFrom");
                  setStartFrom(next);
                  appliedSource.current = null;
                  if (next === null) {
                    changeSelection(() => NOTHING, false);
                    setNeedsDatabase(false);
                    setAddress({ label: "" });
                  }
                }}
                options={startFromOptions}
                placeholder={t("startFromNew")}
              />
              <FieldDescription>{t("startFromHint")}</FieldDescription>
              {sourceQuery.isError && (
                <FieldError>{t("copyFailed")}</FieldError>
              )}
              {byField.copyFromEnvironmentId && (
                <FieldError>
                  {message(byField.copyFromEnvironmentId)}
                </FieldError>
              )}
            </FieldContent>
          </Field>

          <Field data-invalid={nameIssue ? true : undefined}>
            <FieldLabel htmlFor="env-name">{t("name")}</FieldLabel>
            <FieldContent>
              <Input
                id="env-name"
                autoComplete="off"
                placeholder={t("namePlaceholder")}
                value={name}
                aria-invalid={nameIssue ? true : undefined}
                onChange={(e) => {
                  touch("name");
                  setName(e.target.value);
                }}
              />
              {nameIssue && <FieldError>{message(nameIssue)}</FieldError>}
            </FieldContent>
          </Field>

          <Field data-invalid={slugIssue ? true : undefined}>
            <FieldLabel htmlFor="env-slug">{t("slug")}</FieldLabel>
            <FieldContent>
              {/* A path reads left to right in every locale. */}
              <InputGroup dir="ltr">
                <InputGroupAddon>
                  <InputGroupText className="font-mono">
                    /{project.key}/
                  </InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id="env-slug"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={defaultSlug}
                  value={slug}
                  aria-invalid={slugIssue ? true : undefined}
                  onChange={(e) => {
                    touch("slug");
                    setSlug(e.target.value.trim().toLowerCase());
                  }}
                />
              </InputGroup>
              <FieldDescription>{t("slugHint")}</FieldDescription>
              {slugIssue && <FieldError>{message(slugIssue)}</FieldError>}
            </FieldContent>
          </Field>

          <Field data-invalid={reposIssue ? true : undefined}>
            <FieldLabel>{t("services")}</FieldLabel>
            <FieldContent className="gap-3">
              {(picked.length > 0 || repos.length > 0) && (
                <ul className="flex flex-col gap-3">
                  {picked.map((service, index) => {
                    const component = components.find(
                      (c) => c.componentKey === service.componentKey
                    );
                    return (
                      <ServiceListRow
                        key={service.componentKey}
                        componentKey={service.componentKey}
                        repoFullName={component?.repoFullName ?? null}
                        branch={service.branch}
                        index={index}
                        plan={detectionPlan}
                        issue={byField[`services.${index}`]}
                        message={message}
                        onBranch={(branch) =>
                          changeSelection(
                            (sel) => ({
                              ...sel,
                              services: sel.services.map((p, i) =>
                                i === index ? { ...p, branch } : p
                              ),
                            }),
                            false
                          )
                        }
                        onRemove={() =>
                          changeSelection(
                            (sel) => ({
                              ...sel,
                              services: sel.services.filter(
                                (_, i) => i !== index
                              ),
                            }),
                            false
                          )
                        }
                      />
                    );
                  })}
                  {repos.map((repo, index) => (
                    <RepoListRow
                      key={repo.repoFullName}
                      repoFullName={repo.repoFullName}
                      branch={repo.branch}
                      index={index}
                      componentKey={null}
                      plan={detectionPlan}
                      issue={byField[`repos.${index}`]}
                      message={message}
                      onBranch={(branch) =>
                        changeSelection(
                          (sel) => ({
                            ...sel,
                            repos: sel.repos.map((r, i) =>
                              i === index ? { ...r, branch } : r
                            ),
                          }),
                          false
                        )
                      }
                      onRemove={() =>
                        changeSelection(
                          (sel) => ({
                            ...sel,
                            repos: sel.repos.filter((_, i) => i !== index),
                          }),
                          false
                        )
                      }
                    />
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <ServicePicker
                  label={t("addService")}
                  services={components.filter(
                    (c) => !pickedKeys.has(c.componentKey)
                  )}
                  onPick={(componentKey) => addService(componentKey)}
                />
                <RepoPicker
                  label={t("addRepo")}
                  picked={pickedRepos}
                  sourceServiceKeys={sources?.serviceKeys ?? null}
                  onPick={addRepo}
                />
              </div>
              <FieldDescription>{t("servicesHint")}</FieldDescription>
              {reposIssue && <FieldError>{message(reposIssue)}</FieldError>}
            </FieldContent>
          </Field>

          <Field
            orientation="horizontal"
            data-invalid={databaseIssue ? true : undefined}
          >
            <Checkbox
              id="env-needs-database"
              checked={needsDatabase}
              disabled={edited.has("database")}
              onCheckedChange={(value) => {
                touch("database");
                setNeedsDatabase(value === true);
              }}
            />
            <FieldContent>
              <FieldLabel htmlFor="env-needs-database" className="font-normal">
                {t("needsDatabase")}
              </FieldLabel>
              <FieldDescription>
                {edited.has("database")
                  ? t("setInAdvanced")
                  : t("needsDatabaseHint")}
              </FieldDescription>
              {databaseIssue && (
                <FieldError>{message(databaseIssue.code)}</FieldError>
              )}
            </FieldContent>
          </Field>

          <Field data-invalid={addressIssue ? true : undefined}>
            <FieldLabel htmlFor="env-address">{t("address")}</FieldLabel>
            <FieldContent>
              <InputGroup>
                <InputGroupInput
                  id="env-address"
                  className="font-mono"
                  autoComplete="off"
                  placeholder={`${project.key.toLowerCase()}-${draftCtx.slug}`}
                  value={address?.label ?? ""}
                  disabled={address === null || edited.has("domain")}
                  aria-invalid={addressIssue ? true : undefined}
                  onChange={(e) => {
                    touch("address");
                    setAddress({ label: e.target.value.trim().toLowerCase() });
                  }}
                />
                {zoneName && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="font-mono">
                      .{zoneName.toLowerCase()}
                    </InputGroupText>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="env-no-address"
                  checked={address === null}
                  disabled={edited.has("domain")}
                  onCheckedChange={(value) => {
                    touch("address");
                    setAddress(value === true ? null : { label: "" });
                  }}
                />
                <Label htmlFor="env-no-address" className="font-normal">
                  {t("noAddress")}
                </Label>
              </div>
              <FieldDescription>
                {edited.has("domain")
                  ? t("setInAdvanced")
                  : policyName
                    ? t("addressHintPolicy", { policy: policyName })
                    : t("addressHint")}
              </FieldDescription>
              {addressIssue && (
                <FieldError>{message(addressIssue.code)}</FieldError>
              )}
            </FieldContent>
          </Field>

          {showServerPicker && (
            <Field data-invalid={serverIssue ? true : undefined}>
              <FieldLabel htmlFor="env-server">{t("server")}</FieldLabel>
              <FieldContent>
                <SearchSelect
                  id="env-server"
                  aria-label={t("server")}
                  value={serverId}
                  onChange={(value) => {
                    touch("server");
                    setServerId(value);
                  }}
                  options={(options?.servers ?? []).map((s) => ({
                    value: s.id,
                    label: s.name,
                    hint: s.host,
                  }))}
                  placeholder={t("serverPlaceholder")}
                />
                <FieldDescription>{t("serverHint")}</FieldDescription>
                {serverIssue && <FieldError>{message(serverIssue)}</FieldError>}
              </FieldContent>
            </Field>
          )}

          {noServer && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {tSetup("noServerAvailable")}
            </p>
          )}
        </CardContent>
      </Card>

      <Collapsible
        open={advancedOpen}
        onOpenChange={onAdvancedOpenChange}
        className="flex flex-col gap-3"
      >
        <CollapsibleTrigger className="flex w-fit items-center gap-2 rounded-lg text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          {advancedOpen ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground rtl:-scale-x-100" />
          )}
          {tSetup("advancedOptions")}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3">
          {sectionsProps ? (
            <>
              <ServerSection {...sectionsProps} />
              <DatabaseSection {...sectionsProps} />
              <VariablesSection {...sectionsProps} />
              <DomainSection {...sectionsProps} />
              <DeploySection {...sectionsProps} />
              <PipelineChoices
                repos={pipelineRepos}
                issues={byField}
                message={message}
                onChange={(repoFullName, choice) => {
                  touch("advanced");
                  setPipelines((prev) => ({ ...prev, [repoFullName]: choice }));
                }}
              />
              <KindOwnerFields
                kind={kind}
                ownerId={ownerId}
                owners={owners}
                onKind={(value) => {
                  touch("advanced");
                  setKind(value);
                }}
                onOwner={(value) => {
                  touch("advanced");
                  setOwnerId(value);
                }}
              />
            </>
          ) : !checkable.ok ? (
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-muted-foreground">{t("fixFieldsFirst")}</p>
              <ul className="flex flex-col gap-1 text-destructive">
                {checkable.issues.map((issue) => (
                  <li key={`${issue.field}:${issue.code}`}>
                    <span className="font-medium">
                      {fieldLabel(issue.field)}
                    </span>
                    {": "}
                    {message(issue.code)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {checking
                ? tWizard("review.checking")
                : checkFailed
                  ? tWizard("review.previewFailed")
                  : null}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>

      <SetupReview
        creates={showSummary ? (checked?.preview?.creates ?? []) : []}
        plan={showSummary ? (checked?.preview?.plan ?? []) : []}
        lookups={lookups}
        issues={issues}
        projectKey={project.key}
        checking={checking}
        previewFailed={checkFailed}
        onRetry={checkNow}
        submitting={submitting || created}
        onSubmit={onCreate}
      >
        {showSummary && plan && (
          <p className="text-sm text-muted-foreground" data-testid="summary">
            {tSetup("summary", {
              server: plan.summary.serverName || tSetup("summaryNone"),
              port: plan.summary.port ?? tSetup("summaryNone"),
              db: plan.summary.databaseName ?? tSetup("summaryNone"),
              url: plan.summary.url ?? tSetup("summaryNoAddress"),
            })}
          </p>
        )}
      </SetupReview>
    </div>
  );
}
