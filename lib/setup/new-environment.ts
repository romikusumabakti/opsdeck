import { z } from "zod";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import {
  branchSchema,
  componentKeySchema,
  envVarNameSchema,
} from "@/lib/deploy/validation";
import { domainLabelSchema } from "@/lib/domains/validation";
import { suggestServices } from "@/lib/setup/compose-names";
import { type RepoDetection, suggestedBuildSpec } from "@/lib/setup/detect";
import {
  type CopySourceLike,
  copiedVariable,
  defaultDatabaseName,
  defaultDbContainer,
  defaultTargetDirs,
  repoKeyOf,
  variableInput,
} from "@/lib/setup/draft";
import {
  type EnvironmentSetupInput,
  type EnvironmentSetupTarget,
  environmentSetupInputSchema,
  type SetupIssue,
} from "@/lib/setup/schema";
import { slugify } from "@/lib/setup/slug";
import {
  sharedDatabaseNameSchema,
  sharedDatabaseNamesOverlap,
} from "@/lib/validation";
import { keepsCopiedVariable } from "@/lib/variables/template-merge";

// The New environment page's short input (name, services, repos, a database
// checkbox, an address) and its translation to the setup wizard's full input.
// The environment deploys any subset of services: registered ones picked by
// key (`services`) or by repository (`repos`, a registered repository's
// service), and new ones registered from a repository. A copy source fills
// the settings of the services both share and the variables those keep
// (keepsCopiedVariable). Pure: the server (server/services/new-environment)
// reads the context from the database and repo detection, then previews or
// creates the resolved setup and registers the repos the plan lists.

const setupShape = environmentSetupInputSchema.shape;

// Advanced options replace the resolved value of their key. A shared database
// may leave out what the defaults fill (host, names, password variable).
const advancedDatabaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("shared"),
      databaseHostId: z.uuid().optional(),
      dbName: sharedDatabaseNameSchema.optional(),
      dbRole: sharedDatabaseNameSchema.optional(),
      passwordVariable: envVarNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      serviceName: z.string().trim().min(1).max(255).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("external") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const advancedSchema = z
  .object({
    kind: setupShape.kind,
    ownerId: setupShape.ownerId,
    services: setupShape.services.optional(),
    database: advancedDatabaseSchema.optional(),
    // Without the schema's default, so an absent list keeps the copied one.
    variables: setupShape.variables.unwrap().optional(),
    domain: setupShape.domain.optional(),
    targets: setupShape.targets.optional(),
    // The pipeline of a repository registered by this create (admins, org
    // integration:manage): replaces the detected mode and build spec. An
    // entry for a repository already registered is ignored.
    pipelines: z
      .array(
        z
          .object({
            repoFullName: z.string().trim().min(1).max(255),
            mode: z.enum(["custom", "generated"]),
            buildSpec: buildSpecSchema.optional(),
          })
          .strict()
      )
      .max(20)
      .optional(),
  })
  .strict();

export const newEnvironmentInputSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    // The URL name, when the caller edited it; else the name gives one.
    slug: setupShape.slug,
    copyFromEnvironmentId: z.uuid().nullish(),
    // Registered services, each on its branch.
    services: z
      .array(
        z
          .object({ componentKey: componentKeySchema, branch: branchSchema })
          .strict()
      )
      .max(20)
      .default([]),
    // Repositories: a registered one deploys its service, another is
    // registered as a new service. With `services`, both empty and a copy
    // source: the source's services and branches.
    repos: z
      .array(
        z
          .object({
            ciConnectionId: z.uuid(),
            repoFullName: z.string().trim().min(1).max(255),
            branch: branchSchema,
          })
          .strict()
      )
      .max(20)
      .default([]),
    needsDatabase: z.boolean(),
    // null = no address; an empty label = `<project key>-<slug>`.
    address: z
      .object({ label: z.union([domainLabelSchema, z.literal("")]) })
      .strict()
      .nullable(),
    // Only when the project has no default server, or from Advanced options.
    serverId: z.uuid().nullish(),
    advanced: advancedSchema.optional(),
  })
  .strict();

export type NewEnvironmentInput = z.infer<typeof newEnvironmentInputSchema>;

export type NewEnvironmentContext = {
  project: { id: string; key: string; defaultServerId: string | null };
  /** The servers the caller may place the environment on. */
  servers: {
    id: string;
    name: string;
    placement: "restricted" | "open";
    databaseHostId: string | null;
  }[];
  /**
   * The input's repos (and, for a copy, the source's services) with their
   * detection; `component` when the repo is registered.
   */
  repos: {
    repoFullName: string;
    ciConnectionId: string;
    detection: RepoDetection;
    component: { componentKey: string } | null;
  }[];
  /**
   * The input's services that are registered, with their repository's
   * detection where it could be read (it only fills names).
   */
  services: { componentKey: string; detection: RepoDetection | null }[];
  /** The names the templates of the input's registered services define. */
  templateNames: string[];
  /**
   * The repository (repoKeyOf) of every registered service the input or the
   * copy source names, for the default deploy dirs.
   */
  repoOf: Record<string, string>;
  /** The input's URL name, else the unique one its name gives (uniqueEnvSlug). */
  slug: string;
  /** Already filtered by the copy rules (secrets only with variable:read). */
  copySource: CopySourceLike | null;
  /** The chosen server's lowest free entry port (preflight). */
  suggestedPort: number | null;
  defaultZoneId: string | null;
  defaultAccessPolicyId: string | null;
  /** Zone names by id, for the summary's URL. */
  zones: { id: string; name: string }[];
  /** Database, role and user names on the chosen server's database host. */
  existingDbNames: string[];
  /** Registered service keys (global). */
  takenComponentKeys: string[];
};

export type NewEnvironmentRegistration = {
  repoFullName: string;
  ciConnectionId: string;
  componentKey: string;
  pipelineMode: "custom" | "generated";
  buildSpec: BuildSpec | null;
};

export type NewEnvironmentPlan = {
  /** The repos to register (as services) before the setup runs. */
  registrations: NewEnvironmentRegistration[];
  setup: EnvironmentSetupInput;
  summary: {
    serverName: string;
    port: number | null;
    databaseName: string | null;
    url: string | null;
  };
  issues: SetupIssue[];
  /**
   * Non-blocking: a custom pipeline file that does not notify Menara, or
   * an admin's custom choice for a repository without one.
   */
  warnings: {
    field: string;
    code: "pipelineNotNotifying" | "pipelineFileMissing";
  }[];
};

const PASSWORD_VARIABLE = "DB_PASSWORD";
const ENTRY_PORT_VARIABLE = "ENTRY_PORT";
const KEY_MAX_LENGTH = 64;
const DB_NAME_MAX_LENGTH = 63;
const LABEL_MAX_LENGTH = 63;
// The base a repository name gives a service key, before -2, -3.
const REPO_KEY_LENGTH = 60;

/** `base`, else `base-2`, `base-3`, ... the first not in `taken`. */
function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const key = `${base.slice(0, KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(key)) return key;
  }
}

/** The key a repo's name gives: `owner/canary-b` → `canary-b`. */
function repoKey(repoFullName: string): string {
  return (
    slugify(repoFullName.split("/").at(-1) ?? repoFullName, REPO_KEY_LENGTH) ||
    "env"
  );
}

/**
 * The default shared database name, or the first variant no name on the host
 * overlaps under the shared-database rule (`x` vs `x_...`): `cnry_canary_2`
 * next to `cnry_canary` becomes `cnry_canary2`, then `cnry_canary22`, ...
 */
function uniqueDatabaseName(
  projectKey: string,
  slug: string,
  existing: readonly string[]
): string {
  const free = (name: string) =>
    !existing.some((e) => sharedDatabaseNamesOverlap(e, name));
  const cut = (name: string) =>
    name.slice(0, DB_NAME_MAX_LENGTH).replace(/_+$/, "");
  const base = cut(defaultDatabaseName({ projectKey, slug }));
  if (free(base)) return base;
  const compact = cut(`${projectKey.toLowerCase()}_${slug.replace(/-/g, "")}`);
  if (free(compact)) return compact;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const name = `${compact.slice(0, DB_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (free(name)) return name;
  }
}

/** `<project key>-<slug>`, cut to one DNS label (63, no trailing `-`). */
function defaultLabel(projectKey: string, slug: string): string {
  return `${projectKey.toLowerCase()}-${slug}`
    .slice(0, LABEL_MAX_LENGTH)
    .replace(/-+$/, "");
}

type ResolvedRepo = {
  componentKey: string;
  branch: string;
  detection: RepoDetection | null;
  /** The service's repository (repoKeyOf); null when unknown. */
  repo: string | null;
};

export function resolveNewEnvironment(
  input: NewEnvironmentInput,
  ctx: NewEnvironmentContext
): NewEnvironmentPlan {
  const issues: SetupIssue[] = [];
  const warnings: NewEnvironmentPlan["warnings"] = [];
  const registrations: NewEnvironmentRegistration[] = [];
  const projectKey = ctx.project.key;
  const slug = ctx.slug;
  const advanced = input.advanced ?? {};
  const source = ctx.copySource;

  // Server: the one picked, else the project's default; only a placeable
  // one (ctx.servers) is ever used.
  const server = ctx.servers.find(
    (s) => s.id === (input.serverId ?? ctx.project.defaultServerId)
  );
  if (!server) {
    issues.push({
      field: "serverId",
      code: input.serverId
        ? "invalid"
        : ctx.servers.length === 0
          ? "noServerAvailable"
          : "required",
    });
  }

  // Services: registered ones by key or by repository, new ones registered
  // from a repository; each once.
  const takenComponents = new Set(ctx.takenComponentKeys);
  const repos: ResolvedRepo[] = [];
  const picked = new Set<string>();
  if (input.repos.length === 0 && input.services.length === 0 && source) {
    for (const t of source.targets) {
      const known = ctx.repos.find(
        (r) => r.component?.componentKey === t.componentKey
      );
      repos.push({
        componentKey: t.componentKey,
        branch: t.sourceBranch,
        detection: known?.detection ?? null,
        repo: ctx.repoOf[t.componentKey] ?? null,
      });
    }
  } else if (input.repos.length === 0 && input.services.length === 0) {
    issues.push({ field: "repos", code: "required" });
  }
  input.services.forEach((service, index) => {
    const field = `services.${index}`;
    if (picked.has(service.componentKey)) {
      issues.push({ field, code: "duplicate" });
      return;
    }
    const known = ctx.services.find(
      (s) => s.componentKey === service.componentKey
    );
    if (!known) {
      issues.push({ field, code: "invalid" });
      return;
    }
    picked.add(service.componentKey);
    repos.push({
      componentKey: service.componentKey,
      branch: service.branch,
      detection: known.detection,
      repo: ctx.repoOf[service.componentKey] ?? null,
    });
  });
  input.repos.forEach((pickedRepo, index) => {
    const field = `repos.${index}`;
    if (
      input.repos.findIndex(
        (r) => r.repoFullName === pickedRepo.repoFullName
      ) !== index
    ) {
      issues.push({ field, code: "duplicate" });
      return;
    }
    const repo = ctx.repos.find(
      (r) =>
        r.repoFullName === pickedRepo.repoFullName &&
        r.ciConnectionId === pickedRepo.ciConnectionId
    );
    if (!repo) {
      issues.push({ field, code: "invalid" });
      return;
    }
    if (repo.component) {
      if (picked.has(repo.component.componentKey)) {
        issues.push({ field, code: "duplicate" });
        return;
      }
      picked.add(repo.component.componentKey);
      repos.push({
        componentKey: repo.component.componentKey,
        branch: pickedRepo.branch,
        detection: repo.detection,
        repo: repoKeyOf(repo.ciConnectionId, repo.repoFullName),
      });
      return;
    }
    const pipeline = repo.detection.pipeline;
    // A Menara-generated file left behind names its component; keeping that
    // key lets the registration recommit the file (another key is refused).
    const componentKey =
      pipeline.kind === "menara" && !takenComponents.has(pipeline.componentKey)
        ? pipeline.componentKey
        : uniqueKey(repoKey(pickedRepo.repoFullName), takenComponents);
    takenComponents.add(componentKey);
    // Detection decides the pipeline unless an admin chose it: a custom
    // pipeline file is used, else one is generated.
    const pipelineIndex = (advanced.pipelines ?? []).findIndex(
      (p) => p.repoFullName === pickedRepo.repoFullName
    );
    const chosen = advanced.pipelines?.[pipelineIndex];
    const mode =
      chosen?.mode ?? (pipeline.kind === "custom" ? "custom" : "generated");
    let buildSpec: BuildSpec | null = null;
    if (mode === "custom") {
      if (pipeline.kind === "custom" && !pipeline.notifiesMenara) {
        warnings.push({ field, code: "pipelineNotNotifying" });
      } else if (pipeline.kind !== "custom") {
        // Chosen custom, but nothing in the repository builds it yet.
        warnings.push({ field, code: "pipelineFileMissing" });
      }
    } else if (chosen?.buildSpec) {
      buildSpec = chosen.buildSpec;
      // The environment's branch must be one the pipeline builds.
      if (!buildSpec.branches.includes(pickedRepo.branch)) {
        issues.push({
          field: `pipelines.${pipelineIndex}.buildSpec.branches`,
          code: "pipelineBranchMissing",
        });
      }
    } else {
      // No pipeline file, or a Menara-generated one left behind: generate.
      buildSpec = suggestedBuildSpec(
        repo.detection,
        componentKey,
        pickedRepo.branch
      );
      if (!buildSpec) issues.push({ field, code: "repoNotBuildable" });
    }
    registrations.push({
      repoFullName: pickedRepo.repoFullName,
      ciConnectionId: pickedRepo.ciConnectionId,
      componentKey,
      pipelineMode: mode,
      buildSpec,
    });
    repos.push({
      componentKey,
      branch: pickedRepo.branch,
      detection: repo.detection,
      repo: repoKeyOf(repo.ciConnectionId, repo.repoFullName),
    });
  });

  // Targets: one per service, the services of one repository (or of one
  // dir of the copy source) in one dir (defaultTargetDirs: the first is the
  // stack dir), the copy
  // source's settings where it deploys the service too; auto-deploy except
  // for prod. Each dir holds its own `.env`, so its tag variable is its own.
  const kind = advanced.kind ?? null;
  // Group by repository first; a group (or several repositories) the copy
  // source deploys in one dir (e.g. a former app's) takes that dir, so a
  // service of the same repository the source does not deploy joins it.
  const dirOfRepo = new Map<string, string>();
  for (const r of repos) {
    const fromDir = source?.targets.find(
      (t) => t.componentKey === r.componentKey
    )?.deployDir;
    if (fromDir && r.repo && !dirOfRepo.has(r.repo)) {
      dirOfRepo.set(r.repo, fromDir);
    }
  }
  const deployDirs = defaultTargetDirs(
    { projectKey, slug },
    repos.map((r) => {
      const dir = r.repo
        ? dirOfRepo.get(r.repo)
        : source?.targets.find((t) => t.componentKey === r.componentKey)
            ?.deployDir;
      return {
        componentKey: r.componentKey,
        repo: dir ? `dir:${dir}` : r.repo,
      };
    })
  );
  // Tag variables already taken per deploy dir: the first service keeps
  // `IMAGE_TAG`, a later one in the same dir gets its own.
  const tagVariablesInDir = new Map<string, Set<string>>();
  const targets: EnvironmentSetupTarget[] =
    advanced.targets ??
    repos.map((repo, index) => {
      const from = source?.targets.find(
        (t) => t.componentKey === repo.componentKey
      );
      const deployDir = deployDirs[index] as string;
      const taken = tagVariablesInDir.get(deployDir) ?? new Set<string>();
      tagVariablesInDir.set(deployDir, taken);
      const wanted = from?.tagVariable ?? "IMAGE_TAG";
      const tagVariable = taken.has(wanted)
        ? `IMAGE_TAG_${repo.componentKey.toUpperCase().replace(/-/g, "_")}`
        : wanted;
      taken.add(tagVariable);
      return {
        componentKey: repo.componentKey,
        sourceBranch: repo.branch,
        autoDeploy: kind !== "prod",
        deployDir,
        services: from
          ? from.services
          : (repo.detection?.services.map((s) => s.name) ?? []),
        tagVariable,
        preStartCommand: from?.preStartCommand ?? null,
        healthUrl: from?.healthUrl ?? null,
        healthTimeoutSeconds: from?.healthTimeoutSeconds ?? 180,
        backupBeforeDeploy: from?.backupBeforeDeploy ?? false,
      };
    });

  // Compose naming from detection: the compose `name:` and fixed
  // `container_name`s, the first repo that has them.
  const detections = repos.flatMap((r) => (r.detection ? [r.detection] : []));
  const projectName =
    detections.find((d) => d.projectName)?.projectName ?? null;
  const containerNames: Record<string, string | null> = {};
  for (const d of detections) {
    for (const s of d.services) containerNames[s.name] ??= s.containerName;
  }
  const entryService =
    detections.find((d) => d.entryService)?.entryService ?? null;
  const services =
    advanced.services ??
    suggestServices(targets, entryService, null, {
      projectName,
      containerNames,
    });

  // Database: shared on the server's database host, else a container; the
  // copy source's kind when it has one.
  const hostId = server?.databaseHostId ?? null;
  const sharedName = () =>
    uniqueDatabaseName(projectKey, slug, ctx.existingDbNames);
  const dbContainer = () =>
    defaultDbContainer(
      { targets },
      { projectKey, slug },
      {
        projectName,
        containerName: containerNames.db,
      }
    );
  const sourceKind =
    source && source.database.kind !== "none" ? source.database.kind : null;
  const wanted =
    advanced.database ??
    (!input.needsDatabase
      ? { kind: "none" as const }
      : sourceKind === "external"
        ? { kind: "external" as const }
        : sourceKind === "container" || !hostId
          ? { kind: "container" as const }
          : { kind: "shared" as const });
  let database: EnvironmentSetupInput["database"];
  if (wanted.kind === "shared") {
    const dbName = wanted.dbName ?? sharedName();
    database = {
      kind: "shared",
      databaseHostId: wanted.databaseHostId ?? hostId ?? "",
      dbName,
      dbRole: wanted.dbRole ?? dbName,
      passwordVariable: wanted.passwordVariable ?? PASSWORD_VARIABLE,
    };
    if (!database.databaseHostId) {
      issues.push({ field: "database.databaseHostId", code: "required" });
    }
  } else if (wanted.kind === "container") {
    database = {
      kind: "container",
      serviceName: wanted.serviceName ?? dbContainer(),
    };
  } else {
    database = { kind: wanted.kind };
  }

  // Address: a tunnel on the default zone behind the default policy.
  let domain: EnvironmentSetupInput["domain"];
  if (advanced.domain) {
    domain = advanced.domain;
  } else if (input.address) {
    domain = {
      kind: "tunnel",
      zoneId: ctx.defaultZoneId ?? "",
      label: input.address.label || defaultLabel(projectKey, slug),
      // Never null here: null is a public address.
      accessPolicyId: ctx.defaultAccessPolicyId ?? "",
      entryPort: ctx.suggestedPort ?? 0,
    };
    if (!ctx.defaultZoneId) {
      issues.push({ field: "domain.zoneId", code: "required" });
    }
    if (!ctx.defaultAccessPolicyId) {
      issues.push({ field: "domain.accessPolicyId", code: "required" });
    }
    if (ctx.suggestedPort === null) {
      issues.push({ field: "domain.entryPort", code: "required" });
    }
  } else {
    domain = { kind: "none" };
  }

  // Variables: the copy source's by the copy rules, then what the setup
  // needs: the shared database's password and the entry port.
  let variables: EnvironmentSetupInput["variables"];
  if (advanced.variables) {
    variables = [...advanced.variables];
  } else {
    // Only the variables a copy for these services keeps.
    const keys = new Set(repos.map((r) => r.componentKey));
    const templateNames = new Set(ctx.templateNames);
    variables = (source?.variables ?? [])
      .filter((v) =>
        keepsCopiedVariable(v.name, v.definedBy ?? [], keys, templateNames)
      )
      .map((v) => {
        const { input: value, missingValue } = variableInput(copiedVariable(v));
        if (missingValue) {
          issues.push({ field: `variables.${v.name}`, code: "valueRequired" });
        }
        return value;
      });
  }
  if (
    database.kind === "shared" &&
    !variables.some((v) => v.name === database.passwordVariable)
  ) {
    variables.push({ name: database.passwordVariable, kind: "generated" });
  }
  if (
    domain.kind === "tunnel" &&
    !advanced.variables?.some((v) => v.name === ENTRY_PORT_VARIABLE)
  ) {
    const entryPort = {
      name: ENTRY_PORT_VARIABLE,
      kind: "plain" as const,
      value: String(domain.entryPort),
    };
    const at = variables.findIndex((v) => v.name === ENTRY_PORT_VARIABLE);
    if (at === -1) variables.push(entryPort);
    else variables[at] = entryPort;
  }

  const zoneName = (id: string) => ctx.zones.find((z) => z.id === id)?.name;
  const tunnelZone =
    domain.kind === "tunnel" ? zoneName(domain.zoneId) : undefined;
  const url =
    domain.kind === "external"
      ? `https://${domain.hostname}`
      : domain.kind === "tunnel" && tunnelZone
        ? `https://${domain.label}.${tunnelZone.toLowerCase()}`
        : null;

  return {
    registrations,
    setup: {
      projectId: input.projectId,
      name: input.name,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      kind,
      ownerId: advanced.ownerId ?? null,
      copyFromEnvironmentId:
        source?.environment.id ?? input.copyFromEnvironmentId ?? null,
      server: { serverId: server?.id ?? "" },
      targets,
      services,
      entryService,
      database,
      variables,
      domain,
    },
    summary: {
      serverName: server?.name ?? "",
      port: domain.kind === "tunnel" ? domain.entryPort : null,
      databaseName: database.kind === "shared" ? database.dbName : null,
      url,
    },
    issues,
    warnings,
  };
}
