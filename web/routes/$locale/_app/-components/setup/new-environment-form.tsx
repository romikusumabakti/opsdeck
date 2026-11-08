import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRouter } from "@/i18n/navigation";
import {
  buildSetupInput,
  type DraftContext,
  draftFromSetup,
  type EnvironmentDraft,
  effectiveServices,
  issuesByField,
} from "@/lib/setup/draft";
import { isSetupIssueCode } from "@/lib/setup/issues";
import {
  type NewEnvironmentInput,
  type NewEnvironmentPlan,
  newEnvironmentInputSchema,
} from "@/lib/setup/new-environment";
import type { SetupIssue } from "@/lib/setup/schema";
import { baseEnvSlug } from "@/lib/setup/slug";
import { ApiError } from "@/web/api/client";
import { listDatabaseHostsQuery } from "@/web/api/database-hosts";
import {
  copySourceQuery,
  createNewEnvironment,
  type NewEnvironmentPreview,
  previewNewEnvironment,
  type SetupRepoRow,
  setupAccessPoliciesQuery,
  setupOptionsQuery,
  setupReposQuery,
} from "@/web/api/setup";
import { listAssignableUsersQuery } from "@/web/api/users";
import type { ProvisioningLookups } from "../env/provisioning-step-sentence";
import {
  DatabaseSection,
  DeploySection,
  DomainSection,
  type SectionsProps,
  ServerSection,
  VariablesSection,
} from "./environment-sections";
import { SetupReview } from "./review";
import { useApiErrorMessage, useIssueMessage } from "./use-issue-message";

// The New environment page (inside a project): Start from, Name, Repository,
// "Needs a database", Address and Create, with the rest under Advanced
// options. The server resolves the short input (POST
// /api/setup/new-environment/preview); the check runs only on Create, when
// Advanced options opens and when a repository is picked, never per key.
// Errors show for the fields the user has touched, and for all after Create.

export type NewEnvironmentProject = {
  id: string;
  key: string;
  defaultServerId: string | null;
  environments: { id: string; name: string; appId: string | null }[];
};

export type NewEnvironmentApp = {
  id: string;
  appKey: string;
  name: string;
  components: {
    componentKey: string;
    ciConnectionId: string;
    repoFullName: string;
    buildSpec?: { branches: string[] } | null;
  }[];
};

type RepoRow = {
  ciConnectionId: string;
  repoFullName: string;
  branch: string;
};

/** The parts of the input an issue can be about (what the user touches). */
type Group =
  | "startFrom"
  | "name"
  | "repos"
  | "database"
  | "address"
  | "server"
  | "advanced";

/** The Advanced sections whose values replace the resolved ones once edited. */
type AdvancedKey = "targets" | "services" | "database" | "variables" | "domain";

const ENV_KINDS = ["qa", "dev", "release", "sandbox", "prod"] as const;
type EnvKind = (typeof ENV_KINDS)[number];
const NONE = "__none";
const NEW = "__new";
const ENTRY_PORT_VARIABLE = "ENTRY_PORT";
/** Lets the preview run (detection on pick) before a name is typed. */
const PROBE_NAME = "new";
const REPO_SEARCH_DEBOUNCE_MS = 300;

function groupOf(field: string): Group {
  if (field === "name") return "name";
  if (field === "copyFromEnvironmentId") return "startFrom";
  if (field === "repos" || field.startsWith("repos.") || field === "targets") {
    return "repos";
  }
  if (field === "serverId" || field.startsWith("server")) return "server";
  if (field.startsWith("database") || field === "needsDatabase") {
    return "database";
  }
  if (field.startsWith("domain") || field.startsWith("address")) {
    return "address";
  }
  return "advanced";
}

const REPO_CODES = new Set([
  "repoNotFound",
  "repoUnreadable",
  "ciUnavailable",
  "repoOtherApp",
  "repoNotBuildable",
  "duplicate",
  "appKeyTaken",
  "componentKeyTaken",
  "repoLinked",
  "registrationRace",
  "pipelineFileExists",
  "targetMissing",
]);

/**
 * The field a refusal's code points at (a refusal names no field); one of
 * no field of the page is listed under General.
 */
function fieldOfCode(code: string): string {
  if (code === "nameTaken" || code === "environmentNameTaken") return "name";
  if (code === "domainTaken" || code === "domainHostnameTaken") {
    return "domain.label";
  }
  if (code === "noServerAvailable") return "serverId";
  return REPO_CODES.has(code) ? "repos" : "general";
}

/** What each group of an input is, to tell which issues are out of date. */
function snapshotOf(input: NewEnvironmentInput): Record<Group, string> {
  const { database, domain, ...rest } = input.advanced ?? {};
  return {
    startFrom: input.copyFromEnvironmentId ?? "",
    name: input.name,
    repos: JSON.stringify(input.repos),
    database: JSON.stringify([input.needsDatabase, database ?? null]),
    address: JSON.stringify([input.address, domain ?? null]),
    server: input.serverId ?? "",
    advanced: JSON.stringify(rest),
  };
}

type Checked = {
  snapshot: Record<Group, string>;
  /** Ran with PROBE_NAME: its summary is not this environment's. */
  probe: boolean;
  plan: NewEnvironmentPlan | null;
  preview: NewEnvironmentPreview["preview"];
  issues: SetupIssue[];
};

function dedupe(issues: SetupIssue[]): SetupIssue[] {
  return issues.filter(
    (issue, i, all) =>
      all.findIndex((x) => x.field === issue.field && x.code === issue.code) ===
      i
  );
}

/** Zod's verdict on the input, as issues at the fields the page shows. */
function parseInput(
  raw: unknown
):
  | { ok: true; input: NewEnvironmentInput }
  | { ok: false; issues: SetupIssue[] } {
  const parsed = newEnvironmentInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, input: parsed.data };
  return {
    ok: false,
    issues: dedupe(
      parsed.error.issues.map((issue) => ({
        field: issue.path
          .map(String)
          .join(".")
          .replace(/^advanced\./, "")
          .replace(/^address\.label$/, "domain.label"),
        code: "invalid",
      }))
    ),
  };
}

export function NewEnvironmentForm({
  project,
  apps,
  canPublish,
  initialFrom,
  initialRepo,
}: {
  project: NewEnvironmentProject;
  /** The registered apps: their components' repositories and branches. */
  apps: NewEnvironmentApp[];
  /** May put an address behind no policy (org server:manage). */
  canPublish: boolean;
  /** `?from=`: the environment to copy. */
  initialFrom?: string;
  /** `?repo=`: the repository to start with. */
  initialRepo?: string;
}) {
  const t = useTranslations("newEnvironment");
  const tSetup = useTranslations("setup");
  const tWizard = useTranslations("setupWizard");
  const tKinds = useTranslations("environmentKinds");
  const router = useRouter();
  const message = useIssueMessage(project.key);
  const errorMessage = useApiErrorMessage(project.key);

  const components = React.useMemo(
    () =>
      apps.flatMap((app) =>
        app.components.map((c) => ({ ...c, appId: app.id, app }))
      ),
    [apps]
  );
  const componentOfRepo = (repoFullName: string) =>
    components.find((c) => c.repoFullName === repoFullName);
  const startComponent = initialRepo ? componentOfRepo(initialRepo) : undefined;

  // Copy sources: the project's environments of an app, newest first
  // (uuidv7 ids sort by creation).
  const sources = [...project.environments]
    .filter((e) => e.appId !== null)
    .sort((a, b) => b.id.localeCompare(a.id));
  const defaultFrom =
    initialFrom ??
    (initialRepo
      ? startComponent
        ? sources.find((e) => e.appId === startComponent.appId)?.id
        : undefined
      : sources[0]?.id) ??
    null;

  const [startFrom, setStartFrom] = React.useState<string | null>(defaultFrom);
  const [name, setName] = React.useState("");
  const [repos, setRepos] = React.useState<RepoRow[]>(() =>
    !defaultFrom && startComponent
      ? [
          {
            ciConnectionId: startComponent.ciConnectionId,
            repoFullName: startComponent.repoFullName,
            branch: startComponent.buildSpec?.branches[0] ?? "main",
          },
        ]
      : []
  );
  const [needsDatabase, setNeedsDatabase] = React.useState(false);
  const [address, setAddress] = React.useState<{ label: string } | null>({
    label: "",
  });
  const [serverId, setServerId] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<EnvKind | null | undefined>();
  const [ownerId, setOwnerId] = React.useState<string | null | undefined>();
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [advanced, setAdvanced] = React.useState<EnvironmentDraft | null>(null);
  const [edited, setEdited] = React.useState<ReadonlySet<AdvancedKey>>(
    new Set()
  );
  const [touched, setTouched] = React.useState<ReadonlySet<Group>>(new Set());
  const [submitted, setSubmitted] = React.useState(false);
  const [checked, setChecked] = React.useState<Checked | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [checkFailed, setCheckFailed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [created, setCreated] = React.useState(false);
  const requestId = React.useRef(0);

  const touch = (group: Group) =>
    setTouched((prev) => (prev.has(group) ? prev : new Set(prev).add(group)));

  const options = useQuery(setupOptionsQuery(project.id)).data;
  const databaseHosts = useQuery(listDatabaseHostsQuery()).data ?? [];
  const advancedDomain = advanced?.domain.kind === "tunnel";
  const policiesQuery = useQuery({
    ...setupAccessPoliciesQuery(project.id),
    enabled: advancedOpen && advancedDomain,
    retry: false,
  });
  const owners = useQuery({
    ...listAssignableUsersQuery(project.id),
    enabled: advancedOpen,
  }).data;

  // The copy source fills the repositories, branches, database choice and
  // address once per source.
  const sourceQuery = useQuery({
    ...copySourceQuery(startFrom ?? ""),
    enabled: startFrom !== null,
  });
  const source = startFrom ? sourceQuery.data : undefined;
  const sourceRepos = React.useMemo<RepoRow[]>(
    () =>
      (source?.targets ?? []).flatMap((target) => {
        const c = components.find(
          (x) => x.componentKey === target.componentKey
        );
        return c
          ? [
              {
                ciConnectionId: c.ciConnectionId,
                repoFullName: c.repoFullName,
                branch: target.sourceBranch,
              },
            ]
          : [];
      }),
    [source, components]
  );
  const appliedSource = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!source || appliedSource.current === source.environment.id) return;
    appliedSource.current = source.environment.id;
    setRepos(sourceRepos);
    setEdited((prev) => {
      const next = new Set(prev);
      next.delete("targets");
      next.delete("services");
      return next;
    });
    setNeedsDatabase(source.database.kind !== "none");
    setAddress(source.domain.kind === "none" ? null : { label: "" });
  }, [source, sourceRepos]);

  // `?repo=` of a repository no app builds yet: its CI connection comes
  // from the repository search, once.
  const [pendingRepo, setPendingRepo] = React.useState(
    initialRepo && !startComponent ? initialRepo : null
  );
  const pendingRepoRows = useQuery({
    ...setupReposQuery(pendingRepo ?? ""),
    enabled: pendingRepo !== null,
  }).data;
  React.useEffect(() => {
    const row = pendingRepoRows?.find((r) => r.repoFullName === pendingRepo);
    if (!pendingRepoRows) return;
    setPendingRepo(null);
    if (row && !row.appKey) {
      setRepos([
        {
          ciConnectionId: row.ciConnectionId,
          repoFullName: row.repoFullName,
          branch: "main",
        },
      ]);
    }
  }, [pendingRepoRows, pendingRepo]);

  // The app the environment deploys: the copy source's, else the first
  // registered repository's. Other apps' repositories cannot be added.
  const sourceAppId = sources.find((e) => e.id === startFrom)?.appId ?? null;
  const currentApp =
    apps.find((a) => a.id === sourceAppId) ??
    repos.map((r) => componentOfRepo(r.repoFullName)?.app).find(Boolean) ??
    null;

  // The input: a copy whose repositories and branches are the source's
  // sends none (the server takes the source's components).
  const sameAsSource =
    startFrom !== null &&
    repos.length === sourceRepos.length &&
    repos.every(
      (r, i) =>
        r.repoFullName === sourceRepos[i]?.repoFullName &&
        r.branch === sourceRepos[i]?.branch
    );
  const draftCtx: DraftContext = {
    appId: currentApp?.id ?? "",
    projectKey: project.key,
    slug: baseEnvSlug(name || PROBE_NAME),
    suggestedServices: [],
    suggestedEntryPort: checked?.plan?.summary.port ?? null,
    defaultZoneId: options?.zones[0]?.id ?? "",
    entryService: checked?.plan?.setup.entryService ?? null,
  };

  function advancedInput(): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    if (kind !== undefined) out.kind = kind;
    if (ownerId !== undefined) out.ownerId = ownerId;
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
      copyFromEnvironmentId: startFrom,
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

  const parsed = parseInput(rawInput(name));
  const snapshot = parsed.ok ? snapshotOf(parsed.input) : null;

  /**
   * Resolves an input on the server. A stale answer (another check started
   * since) is dropped. Untouched Advanced sections follow the plan.
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
      setAdvanced((prev) =>
        prev
          ? {
              ...prev,
              serverId: seeded.serverId,
              targets: edited.has("targets") ? prev.targets : seeded.targets,
              serviceNames: edited.has("services")
                ? prev.serviceNames
                : seeded.serviceNames,
              database: edited.has("database")
                ? prev.database
                : seeded.database,
              variables: edited.has("variables")
                ? prev.variables
                : seeded.variables,
              domain: edited.has("domain") ? prev.domain : seeded.domain,
            }
          : seeded
      );
      return result;
    } catch (error) {
      if (id !== requestId.current) return null;
      // A coded refusal (a repository the Panel cannot read, the CI server
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

  /** A check of what the page shows now; a name is filled in if none. */
  function checkNow() {
    if (created) return;
    const probe = name.trim() === "";
    const result = parseInput(rawInput(probe ? PROBE_NAME : name));
    if (result.ok) void check(result.input, probe);
  }

  // A picked repository runs the check (detection) once the state has
  // settled. Edited deploy targets and containers follow a changed list.
  const [repoCheck, setRepoCheck] = React.useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on request only (repoCheck), with that render's state
  React.useEffect(() => {
    if (repoCheck > 0) checkNow();
  }, [repoCheck]);
  function changeRepos(update: (rows: RepoRow[]) => RepoRow[], recheck = true) {
    touch("repos");
    setRepos(update);
    setEdited((prev) => {
      const next = new Set(prev);
      next.delete("targets");
      next.delete("services");
      return next;
    });
    if (recheck) setRepoCheck((n) => n + 1);
  }
  function addRepo(row: { ciConnectionId: string; repoFullName: string }) {
    const component = componentOfRepo(row.repoFullName);
    changeRepos((rows) =>
      rows.some((r) => r.repoFullName === row.repoFullName)
        ? rows
        : [
            ...rows,
            {
              ...row,
              branch: component?.buildSpec?.branches[0] ?? "main",
            },
          ]
    );
  }

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
    const changed = new Set(edited);
    if (next.targets !== advanced.targets) changed.add("targets");
    if (next.serviceNames !== advanced.serviceNames) changed.add("services");
    if (next.database !== advanced.database) changed.add("database");
    if (next.variables !== advanced.variables) changed.add("variables");
    if (next.domain !== advanced.domain) changed.add("domain");
    setEdited(changed);
    if (next.serverId !== advanced.serverId) {
      touch("server");
      setServerId(next.serverId || null);
    }
    setAdvanced(next);
  }

  async function onCreate() {
    if (created || submitting) return;
    setSubmitted(true);
    if (!parsed.ok || name.trim() === "") return;
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

  // The issues to show: the check's, for the parts unchanged since it ran,
  // and the browser's own; each only once its part was touched or after
  // Create. A missing server shows at once: nothing on the page fixes it.
  const noServerKnown =
    options !== undefined &&
    options.servers.length === 0 &&
    !project.defaultServerId;
  const changedSince = (group: Group) =>
    !snapshot ||
    !checked ||
    (group === "advanced"
      ? (Object.keys(snapshot) as Group[]).some(
          (g) => snapshot[g] !== checked.snapshot[g]
        )
      : snapshot[group] !== checked.snapshot[group]);
  const clientIssues: SetupIssue[] = [
    ...(name.trim() === "" ? [{ field: "name", code: "required" }] : []),
    ...(parsed.ok ? [] : parsed.issues.filter((i) => i.field !== "name")),
  ];
  const checkIssues = (checked?.issues ?? []).filter(
    (i) => !(checked?.probe && groupOf(i.field) === "name")
  );
  const issues = dedupe([
    ...(noServerKnown
      ? [{ field: "serverId", code: "noServerAvailable" }]
      : []),
    ...[...clientIssues, ...checkIssues].filter((issue) => {
      if (issue.code === "noServerAvailable") return true;
      const group = groupOf(issue.field);
      if (!(submitted || touched.has(group))) return false;
      return clientIssues.includes(issue) || !changedSince(group);
    }),
  ]);
  const byField = issuesByField(issues);
  const noServer = issues.some((i) => i.code === "noServerAvailable");
  const firstOf = (group: Group) =>
    issues.find((i) => groupOf(i.field) === group);

  const plan = checked?.plan ?? null;
  const showSummary =
    plan !== null && !checked?.probe && !changedSince("name") && !noServer;
  const zones = options?.zones ?? [];
  const planDomain = plan?.setup.domain;
  const zoneName = (
    zones.find(
      (z) => planDomain?.kind === "tunnel" && z.id === planDomain.zoneId
    ) ?? zones[0]
  )?.name;
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

  // The repositories of the app the list misses (an older environment
  // copied after the app gained a component): one click adds each.
  const missingComponents =
    byField.targets === "targetMissing" && currentApp
      ? currentApp.components.filter(
          (c) => !repos.some((r) => r.repoFullName === c.repoFullName)
        )
      : [];

  const nameIssue = byField.name;
  const reposIssue = byField.repos ?? byField.targets;
  const databaseIssue = firstOf("database");
  const addressIssue = firstOf("address");
  const serverIssue = byField.serverId ?? byField["server.serverId"];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor="env-start-from">{t("startFrom")}</FieldLabel>
            <FieldContent>
              <Select
                value={startFrom ?? NEW}
                onValueChange={(value) => {
                  const next = value && value !== NEW ? value : null;
                  touch("startFrom");
                  setStartFrom(next);
                  appliedSource.current = null;
                  if (next === null) {
                    changeRepos(() => [], false);
                    setNeedsDatabase(false);
                    setAddress({ label: "" });
                  }
                }}
              >
                <SelectTrigger id="env-start-from" aria-label={t("startFrom")}>
                  <SelectValue>
                    {(value: string) => {
                      // `?from=` may name an environment of another project.
                      const copyName =
                        sources.find((e) => e.id === value)?.name ??
                        (value === startFrom
                          ? sourceQuery.data?.environment.name
                          : undefined);
                      return copyName
                        ? t("startFromCopy", { name: copyName })
                        : t("startFromNew");
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW}>{t("startFromNew")}</SelectItem>
                  {sources.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {t("startFromCopy", { name: e.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

          <Field data-invalid={reposIssue ? true : undefined}>
            <FieldLabel>{t("repository")}</FieldLabel>
            <FieldContent className="gap-3">
              {repos.length > 0 && (
                <ul className="flex flex-col gap-3">
                  {repos.map((repo, index) => (
                    <RepoListRow
                      key={repo.repoFullName}
                      repo={repo}
                      index={index}
                      plan={showDetection(checked, snapshot) ? plan : null}
                      issue={byField[`repos.${index}`]}
                      message={message}
                      onBranch={(branch) =>
                        changeRepos(
                          (rows) =>
                            rows.map((r, i) =>
                              i === index ? { ...r, branch } : r
                            ),
                          false
                        )
                      }
                      onRemove={() =>
                        changeRepos(
                          (rows) => rows.filter((_, i) => i !== index),
                          false
                        )
                      }
                    />
                  ))}
                </ul>
              )}
              <RepoPicker
                label={repos.length === 0 ? t("chooseRepo") : t("addRepo")}
                picked={repos.map((r) => r.repoFullName)}
                currentAppKey={currentApp?.appKey ?? null}
                onPick={addRepo}
              />
              {reposIssue && (
                <FieldError>
                  {message(reposIssue)}
                  {missingComponents.length > 0 && (
                    <span className="mt-2 flex flex-wrap gap-2">
                      {missingComponents.map((c) => (
                        <Button
                          key={c.componentKey}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addRepo(c)}
                        >
                          <Plus data-icon="inline-start" />
                          {t("addMissingRepo", { repo: c.repoFullName })}
                        </Button>
                      ))}
                    </span>
                  )}
                </FieldError>
              )}
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
                {edited.has("domain") ? t("setInAdvanced") : t("addressHint")}
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
                <Select
                  value={serverId}
                  onValueChange={(value) => {
                    touch("server");
                    setServerId(value ?? null);
                  }}
                >
                  <SelectTrigger id="env-server" aria-label={t("server")}>
                    <SelectValue>
                      {(value: string | null) =>
                        options?.servers.find((s) => s.id === value)?.name ??
                        t("serverPlaceholder")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(options?.servers ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} ({s.host})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <Card>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="env-kind">{t("kind")}</FieldLabel>
                    <Select
                      value={kind ?? NONE}
                      onValueChange={(value) => {
                        touch("advanced");
                        setKind(
                          value && value !== NONE ? (value as EnvKind) : null
                        );
                      }}
                    >
                      <SelectTrigger id="env-kind" aria-label={t("kind")}>
                        <SelectValue>
                          {(value: string) =>
                            value === NONE
                              ? t("kindNone")
                              : tKinds(value as EnvKind)
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("kindNone")}</SelectItem>
                        {ENV_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {tKinds(k)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="env-owner">{t("owner")}</FieldLabel>
                    <Select
                      value={ownerId ?? NONE}
                      onValueChange={(value) => {
                        touch("advanced");
                        setOwnerId(value && value !== NONE ? value : null);
                      }}
                    >
                      <SelectTrigger id="env-owner" aria-label={t("owner")}>
                        <SelectValue>
                          {(value: string) =>
                            owners?.find((u) => u.id === value)?.name ??
                            t("ownerNone")
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("ownerNone")}</SelectItem>
                        {(owners ?? []).map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </CardContent>
              </Card>
            </>
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

/** A check about the repositories shown now (detection follows the list). */
function showDetection(
  checked: Checked | null,
  snapshot: Record<Group, string> | null
): boolean {
  return (
    checked !== null &&
    snapshot !== null &&
    checked.snapshot.repos === snapshot.repos
  );
}

function RepoListRow({
  repo,
  index,
  plan,
  issue,
  message,
  onBranch,
  onRemove,
}: {
  repo: RepoRow;
  index: number;
  plan: NewEnvironmentPlan | null;
  issue: string | undefined;
  message: (code: string) => string;
  onBranch: (branch: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("newEnvironment");
  const registration = plan?.registrations.find(
    (r) => r.repoFullName === repo.repoFullName
  );
  const target = plan?.setup.targets.find(
    (x) =>
      x.componentKey === registration?.componentKey ||
      (!registration && plan.setup.targets.indexOf(x) === index)
  );
  const notNotifying = plan?.warnings.some(
    (w) => w.field === `repos.${index}` && w.code === "pipelineNotNotifying"
  );
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm">
          {repo.repoFullName}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("removeRepo", { repo: repo.repoFullName })}
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
          value={repo.branch}
          onChange={(e) => onBranch(e.target.value.trim())}
        />
      </div>
      {plan && target && (
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
                <code className="font-mono text-xs">{chunks}</code>
              ),
            })}
          </span>
        </p>
      )}
      {issue && <FieldError>{message(issue)}</FieldError>}
    </li>
  );
}

/**
 * The repository search (the CI server's repositories). Repositories of
 * another app are listed but cannot be picked; their app is named.
 */
function RepoPicker({
  label,
  picked,
  currentAppKey,
  onPick,
}: {
  label: string;
  picked: string[];
  currentAppKey: string | null;
  onPick: (row: SetupRepoRow) => void;
}) {
  const t = useTranslations("newEnvironment");
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const debounced = useDebouncedValue(q, REPO_SEARCH_DEBOUNCE_MS);
  const rows = useQuery({ ...setupReposQuery(debounced), enabled: open });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id="env-repo-picker"
            type="button"
            variant="outline"
            className="w-fit"
          />
        }
      >
        <Plus data-icon="inline-start" />
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("searchRepos")}
            value={q}
            onValueChange={setQ}
          />
          <CommandList>
            <CommandEmpty>
              {rows.isError ? t("reposFailed") : t("noRepos")}
            </CommandEmpty>
            <CommandGroup>
              {(rows.data ?? []).map((row) => {
                const otherApp =
                  row.appKey !== null &&
                  currentAppKey !== null &&
                  row.appKey !== currentAppKey;
                return (
                  <CommandItem
                    key={`${row.ciConnectionId}:${row.repoFullName}`}
                    value={`${row.ciConnectionId}:${row.repoFullName}`}
                    disabled={otherApp || picked.includes(row.repoFullName)}
                    onSelect={() => {
                      onPick(row);
                      requestAnimationFrame(() => setOpen(false));
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {row.repoFullName}
                    </span>
                    {row.appName && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {row.appName}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
