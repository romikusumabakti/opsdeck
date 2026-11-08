import { z } from "zod";
import type { BuildSpec } from "@/lib/ci/build-spec";
import { branchSchema, envVarNameSchema } from "@/lib/deploy/validation";
import { domainLabelSchema } from "@/lib/domains/validation";
import { suggestServices } from "@/lib/setup/compose-names";
import { type RepoDetection, suggestedBuildSpec } from "@/lib/setup/detect";
import {
  type CopySourceLike,
  copiedVariable,
  defaultDatabaseName,
  defaultDbContainer,
  defaultDeployDir,
  variableInput,
} from "@/lib/setup/draft";
import {
  type EnvironmentSetupInput,
  type EnvironmentSetupTarget,
  environmentSetupInputSchema,
  type SetupIssue,
} from "@/lib/setup/schema";
import { baseEnvSlug } from "@/lib/setup/slug";
import {
  sharedDatabaseNameSchema,
  sharedDatabaseNamesOverlap,
} from "@/lib/validation";

// The New environment page's short input (name, repos, a database checkbox,
// an address) and its translation to the setup wizard's full input. Pure: the
// server (server/services/new-environment) reads the context from the
// database and repo detection, then previews or creates the resolved setup
// and registers the repos the plan lists.

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
  })
  .strict();

export const newEnvironmentInputSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    copyFromEnvironmentId: z.uuid().nullish(),
    // Empty with a copy source: the source's components and branches.
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
      .max(20),
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
   * The input's repos (and, for a copy, the source's components) with their
   * detection; `component` when the repo is registered.
   */
  repos: {
    repoFullName: string;
    ciConnectionId: string;
    detection: RepoDetection;
    component: { componentKey: string; appId: string; appKey: string } | null;
  }[];
  /** The app of the copy source, else of the first registered repo. */
  app: { id: string; key: string } | null;
  /** The environment's unique URL name (uniqueEnvSlug of the input's name). */
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
  /** Registered component and app keys (both are global). */
  takenComponentKeys: string[];
  takenAppKeys: string[];
};

export type NewEnvironmentRegistration = {
  repoFullName: string;
  ciConnectionId: string;
  componentKey: string;
  pipelineMode: "custom" | "generated";
  buildSpec: BuildSpec | null;
};

export type NewEnvironmentPlan = {
  /** The repos to register before the setup runs. */
  registrations: NewEnvironmentRegistration[];
  /** The existing app's key, or the new app's (from the first repo). */
  appKey: string;
  setup: Omit<EnvironmentSetupInput, "appId">;
  summary: {
    serverName: string;
    port: number | null;
    databaseName: string | null;
    url: string | null;
  };
  issues: SetupIssue[];
  warnings: { field: string; code: "pipelineNotNotifying" }[];
};

const PASSWORD_VARIABLE = "DB_PASSWORD";
const ENTRY_PORT_VARIABLE = "ENTRY_PORT";
const KEY_MAX_LENGTH = 64;
const DB_NAME_MAX_LENGTH = 63;
const LABEL_MAX_LENGTH = 63;

/** `base`, else `base-2`, `base-3`, ... the first not in `taken`. */
function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const key = `${base.slice(0, KEY_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(key)) return key;
  }
}

/** The key a repo's name gives: `owner/panel-canary-2` → `panel-canary-2`. */
function repoKey(repoFullName: string): string {
  return baseEnvSlug(repoFullName.split("/").at(-1) ?? repoFullName);
}

/**
 * The default shared database name, or the first variant no name on the host
 * overlaps under the shared-database rule (`x` vs `x_...`): `pcan_canary_2`
 * next to `pcan_canary` becomes `pcan_canary2`, then `pcan_canary22`, ...
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

  // Repos: registered ones keep their component, new ones are registered.
  const takenComponents = new Set(ctx.takenComponentKeys);
  const repos: ResolvedRepo[] = [];
  if (input.repos.length === 0 && source) {
    for (const t of source.targets) {
      const known = ctx.repos.find(
        (r) => r.component?.componentKey === t.componentKey
      );
      repos.push({
        componentKey: t.componentKey,
        branch: t.sourceBranch,
        detection: known?.detection ?? null,
      });
    }
  } else if (input.repos.length === 0) {
    issues.push({ field: "repos", code: "required" });
  }
  input.repos.forEach((picked, index) => {
    const field = `repos.${index}`;
    if (
      input.repos.findIndex((r) => r.repoFullName === picked.repoFullName) !==
      index
    ) {
      issues.push({ field, code: "duplicate" });
      return;
    }
    const repo = ctx.repos.find(
      (r) =>
        r.repoFullName === picked.repoFullName &&
        r.ciConnectionId === picked.ciConnectionId
    );
    if (!repo) {
      issues.push({ field, code: "invalid" });
      return;
    }
    if (repo.component) {
      if (ctx.app && repo.component.appId !== ctx.app.id) {
        issues.push({ field, code: "repoOtherApp" });
        return;
      }
      repos.push({
        componentKey: repo.component.componentKey,
        branch: picked.branch,
        detection: repo.detection,
      });
      return;
    }
    const pipeline = repo.detection.pipeline;
    // A Panel-generated file left behind names its component; keeping that
    // key lets the registration recommit the file (another key is refused).
    const componentKey =
      pipeline.kind === "panel" && !takenComponents.has(pipeline.componentKey)
        ? pipeline.componentKey
        : uniqueKey(repoKey(picked.repoFullName), takenComponents);
    takenComponents.add(componentKey);
    let buildSpec: BuildSpec | null = null;
    if (pipeline.kind === "custom") {
      if (!pipeline.notifiesPanel) {
        warnings.push({ field, code: "pipelineNotNotifying" });
      }
    } else {
      // No pipeline file, or a Panel-generated one left behind: generate.
      buildSpec = suggestedBuildSpec(
        repo.detection,
        componentKey,
        picked.branch
      );
      if (!buildSpec) issues.push({ field, code: "repoNotBuildable" });
    }
    registrations.push({
      repoFullName: picked.repoFullName,
      ciConnectionId: picked.ciConnectionId,
      componentKey,
      pipelineMode: pipeline.kind === "custom" ? "custom" : "generated",
      buildSpec,
    });
    repos.push({
      componentKey,
      branch: picked.branch,
      detection: repo.detection,
    });
  });

  // An existing app keeps its key; only a new app gets one.
  const appKey =
    ctx.app?.key ??
    uniqueKey(
      repoKey(input.repos[0]?.repoFullName ?? slug),
      new Set(ctx.takenAppKeys)
    );

  // Targets: one per repo in the stack's deploy dir, the copy source's
  // settings where it has the component; auto-deploy except for prod.
  const kind = advanced.kind ?? null;
  const deployDir = defaultDeployDir({ projectKey, slug });
  const targets: EnvironmentSetupTarget[] =
    advanced.targets ??
    repos.map((repo) => {
      const from = source?.targets.find(
        (t) => t.componentKey === repo.componentKey
      );
      return {
        componentKey: repo.componentKey,
        sourceBranch: repo.branch,
        autoDeploy: kind !== "prod",
        deployDir,
        services: from
          ? from.services
          : (repo.detection?.services.map((s) => s.name) ?? []),
        tagVariable: from?.tagVariable ?? "IMAGE_TAG",
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
    variables = (source?.variables ?? []).map((v) => {
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
    appKey,
    setup: {
      projectId: input.projectId,
      name: input.name,
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
