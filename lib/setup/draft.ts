import { composeContainerName } from "@/lib/setup/compose-names";
import {
  type EnvironmentSetupInput,
  environmentSetupInputSchema,
  SETUP_SERVICE_ROLES,
  type SetupIssue,
  type SetupServiceRole,
} from "@/lib/setup/schema";

// The setup forms' state and its translation to the API input (the New
// environment page's Advanced options). The draft holds what the user
// chose; anything they have not touched is `null` or empty and resolves to a
// default when the input is built (the deploy dir from the environment's
// URL name, container names from the preview's suggestions, the entry port
// from the server's preflight), so no effect has to copy defaults into state.

export type VariableKind = "plain" | "secret" | "generated";

export type VariableDraft = {
  /** Stable row key (the name changes while a new row is typed). */
  key: string;
  name: string;
  kind: VariableKind;
  escrow: boolean;
  /** The row comes from the copy source (its name and kind are fixed). */
  fromSource: boolean;
  /** The create would copy a secret's value (never sent to the browser). */
  copyable: boolean;
  /** A plain value, or one the user typed; never a secret from the source. */
  value: string;
  /** The user has to type a value (an unreadable plain value, a secret). */
  required: boolean;
};

export type VariableHandling = "generate" | "copy" | "enter";

/** What happens to a variable's value when the environment is created. */
export function variableHandling(
  v: Pick<VariableDraft, "kind" | "fromSource" | "copyable">
): VariableHandling {
  if (v.kind === "generated") return "generate";
  if (v.kind === "secret" && v.fromSource && v.copyable) return "copy";
  return "enter";
}

export type TargetDraft = {
  componentKey: string;
  sourceBranch: string;
  autoDeploy: boolean;
  /** null = the default (defaultDeployDir). */
  deployDir: string | null;
  /** Compose service names, comma separated while typed. */
  services: string;
  tagVariable: string;
  preStartCommand: string;
  healthUrl: string;
  healthTimeoutSeconds: string;
  backupBeforeDeploy: boolean;
};

export type DatabaseDraft = {
  kind: "shared" | "container" | "external" | "none";
  databaseHostId: string;
  /** null = the default (defaultDatabaseName). */
  dbName: string | null;
  dbRole: string | null;
  passwordVariable: string;
  /** null = the default (the compose name of a `db` service). */
  serviceName: string | null;
};

export const PUBLIC_POLICY = "__public";

export type DomainDraft = {
  kind: "none" | "tunnel" | "external";
  zoneId: string;
  /** null = the environment's URL name. */
  label: string | null;
  /** A policy id, PUBLIC_POLICY, or "" (not chosen). */
  accessPolicyId: string;
  /** null = the preview's suggestion. */
  entryPort: string | null;
  hostname: string;
};

export type EnvironmentDraft = {
  projectId: string;
  name: string;
  copyFromEnvironmentId: string | null;
  serverId: string;
  targets: TargetDraft[];
  /** Container names the user edited, by role. */
  serviceNames: Partial<Record<SetupServiceRole, string>>;
  database: DatabaseDraft;
  variables: VariableDraft[];
  domain: DomainDraft;
};

/** What the draft resolves its defaults from. */
export type DraftContext = {
  appId: string;
  projectKey: string;
  /** The slug the server gave the name, else the local approximation. */
  slug: string;
  suggestedServices: { role: SetupServiceRole; serviceName: string }[];
  suggestedEntryPort: number | null;
  /** The first zone, when the draft has none. */
  defaultZoneId: string;
  /** The compose service the domain routes to (repo detection), if known. */
  entryService?: string | null;
  /** Fills a placeholder so the preview can run and suggest a port. */
  probe?: boolean;
};

/**
 * `/deployments/<project key>-<slug>`. An app is one stack (one compose file,
 * one `.env`), so every component deploys into the same directory.
 */
export function defaultDeployDir(
  ctx: Pick<DraftContext, "projectKey" | "slug">
): string {
  return `/deployments/${ctx.projectKey.toLowerCase()}-${ctx.slug}`;
}

/** `<project key>_<slug>` with underscores, the shared database name rule. */
export function defaultDatabaseName(
  ctx: Pick<DraftContext, "projectKey" | "slug">
): string {
  return `${ctx.projectKey.toLowerCase()}_${ctx.slug.replace(/-/g, "_")}`;
}

/**
 * The container name Compose gives a `db` service in the first target's dir:
 * its `container_name` when the repository fixes one, else
 * `<project>-db-1` with the compose `name:` (when set) as the project.
 */
export function defaultDbContainer(
  draft: { targets: readonly Pick<TargetDraft, "deployDir">[] },
  ctx: Pick<DraftContext, "projectKey" | "slug">,
  detected?: { projectName?: string | null; containerName?: string | null }
): string {
  const first = draft.targets[0];
  const dir = first ? (first.deployDir ?? defaultDeployDir(ctx)) : "";
  return composeContainerName(dir, "db", detected);
}

export function emptyTarget(
  componentKey: string,
  sourceBranch = "main"
): TargetDraft {
  return {
    componentKey,
    sourceBranch,
    autoDeploy: false,
    deployDir: null,
    services: "",
    tagVariable: "IMAGE_TAG",
    preStartCommand: "",
    healthUrl: "",
    healthTimeoutSeconds: "180",
    backupBeforeDeploy: false,
  };
}

export function emptyDraft(
  projectId: string,
  components: { componentKey: string; branch?: string }[]
): EnvironmentDraft {
  return {
    projectId,
    name: "",
    copyFromEnvironmentId: null,
    serverId: "",
    targets: components.map((c) => emptyTarget(c.componentKey, c.branch)),
    serviceNames: {},
    database: {
      kind: "none",
      databaseHostId: "",
      dbName: null,
      dbRole: null,
      passwordVariable: "DB_PASSWORD",
      serviceName: null,
    },
    variables: [],
    domain: {
      kind: "none",
      zoneId: "",
      label: null,
      accessPolicyId: "",
      entryPort: null,
      hostname: "",
    },
  };
}

/** The part of the copy-source response the draft uses. */
export type CopySourceLike = {
  environment: { id: string };
  serverId: string | null;
  targets: {
    componentKey: string;
    sourceBranch: string;
    autoDeploy: boolean;
    services: string[];
    tagVariable: string;
    preStartCommand?: string | null;
    healthUrl?: string | null;
    healthTimeoutSeconds: number;
    backupBeforeDeploy: boolean;
  }[];
  database: {
    kind: DatabaseDraft["kind"];
    databaseHostId: string | null;
  };
  domain: {
    kind: DomainDraft["kind"];
    zoneId: string | null;
    accessPolicyId: string | null;
  };
  variables: {
    name: string;
    kind: VariableKind;
    escrow: boolean;
    hasValue: boolean;
    copyable: boolean;
    value?: string;
  }[];
};

/**
 * A copy source's variable as a draft row: only a plain value is ever shown
 * or sent back; a value the caller has to type is marked required.
 */
export function copiedVariable(
  v: CopySourceLike["variables"][number]
): VariableDraft {
  return {
    key: v.name,
    name: v.name,
    kind: v.kind,
    escrow: v.escrow,
    fromSource: true,
    copyable: v.copyable,
    value: v.kind === "plain" && !v.escrow ? (v.value ?? "") : "",
    required:
      v.kind === "generated"
        ? false
        : v.escrow ||
          (v.kind === "secret"
            ? !v.copyable
            : v.hasValue && v.value === undefined),
  };
}

/**
 * Fills the draft from a copy source: server (when the caller may use it),
 * targets, database kind and host, domain kind, zone and policy, and the
 * variables by name. The deploy dir, names, label and port stay defaults. A
 * secret's value is never in the source response; it is dropped here too.
 */
export function applyCopySource(
  draft: EnvironmentDraft,
  source: CopySourceLike,
  allowedServerIds: readonly string[]
): EnvironmentDraft {
  const next: EnvironmentDraft = {
    ...draft,
    copyFromEnvironmentId: source.environment.id,
    serverId:
      source.serverId && allowedServerIds.includes(source.serverId)
        ? source.serverId
        : draft.serverId,
    targets: draft.targets.map((target) => {
      const from = source.targets.find(
        (t) => t.componentKey === target.componentKey
      );
      if (!from) return target;
      return {
        ...target,
        sourceBranch: from.sourceBranch,
        autoDeploy: from.autoDeploy,
        services: from.services.join(", "),
        tagVariable: from.tagVariable,
        preStartCommand: from.preStartCommand ?? "",
        healthUrl: from.healthUrl ?? "",
        healthTimeoutSeconds: String(from.healthTimeoutSeconds),
        backupBeforeDeploy: from.backupBeforeDeploy,
      };
    }),
    database: {
      ...draft.database,
      kind: source.database.kind,
      databaseHostId: source.database.databaseHostId ?? "",
    },
    domain: {
      ...draft.domain,
      kind: source.domain.kind,
      zoneId: source.domain.zoneId ?? draft.domain.zoneId,
      accessPolicyId:
        source.domain.kind === "tunnel"
          ? (source.domain.accessPolicyId ?? PUBLIC_POLICY)
          : draft.domain.accessPolicyId,
    },
    variables: source.variables.map(copiedVariable),
  };
  return withPasswordVariable(next);
}

/**
 * A shared database needs its password variable among the environment's
 * variables; when none has that name, a generated one is added.
 */
export function withPasswordVariable(
  draft: EnvironmentDraft
): EnvironmentDraft {
  const { kind, passwordVariable } = draft.database;
  if (
    kind !== "shared" ||
    !passwordVariable ||
    draft.variables.some((v) => v.name === passwordVariable)
  ) {
    return draft;
  }
  return {
    ...draft,
    variables: [
      ...draft.variables,
      {
        key: passwordVariable,
        name: passwordVariable,
        kind: "generated",
        escrow: false,
        fromSource: false,
        copyable: false,
        value: "",
        required: false,
      },
    ],
  };
}

/** The container names in effect: suggestions, then the user's edits. */
export function effectiveServices(
  draft: EnvironmentDraft,
  ctx: Pick<DraftContext, "suggestedServices">
): { role: SetupServiceRole; serviceName: string }[] {
  return SETUP_SERVICE_ROLES.flatMap((role) => {
    const suggested = ctx.suggestedServices.find((s) => s.role === role);
    const serviceName = draft.serviceNames[role] ?? suggested?.serviceName;
    return serviceName ? [{ role, serviceName }] : [];
  });
}

const splitList = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A draft row as the API's variable input (a generated value is made by the
 * server, a copied secret is read there); `missingValue` when the user still
 * has to type the value.
 */
export function variableInput(v: VariableDraft): {
  input: EnvironmentSetupInput["variables"][number];
  missingValue: boolean;
} {
  const handling = variableHandling(v);
  if (handling === "generate") {
    return { input: { name: v.name, kind: v.kind }, missingValue: false };
  }
  if (handling === "copy") {
    return {
      input: { name: v.name, kind: v.kind, copy: true },
      missingValue: false,
    };
  }
  return {
    input: { name: v.name, kind: v.kind, value: v.value },
    missingValue: v.required && v.value === "",
  };
}

/**
 * A resolved setup (the New environment page's plan) as a draft, for the
 * page's Advanced options: every value explicit, so none falls back to a
 * default, except a role equal to the database name, which stays null and
 * follows the name. `required` marks the variables the plan asks a value for.
 */
export function draftFromSetup(
  setup: Omit<EnvironmentSetupInput, "appId">,
  issues: readonly SetupIssue[]
): EnvironmentDraft {
  const db = setup.database;
  const d = setup.domain;
  return {
    projectId: setup.projectId,
    name: setup.name,
    copyFromEnvironmentId: setup.copyFromEnvironmentId ?? null,
    serverId: setup.server.serverId,
    targets: setup.targets.map((t) => ({
      componentKey: t.componentKey,
      sourceBranch: t.sourceBranch,
      autoDeploy: t.autoDeploy,
      deployDir: t.deployDir,
      services: t.services.join(", "),
      tagVariable: t.tagVariable,
      preStartCommand: t.preStartCommand ?? "",
      healthUrl: t.healthUrl ?? "",
      healthTimeoutSeconds: String(t.healthTimeoutSeconds),
      backupBeforeDeploy: t.backupBeforeDeploy,
    })),
    serviceNames: Object.fromEntries(
      setup.services.map((s) => [s.role, s.serviceName])
    ),
    database: {
      kind: db.kind,
      databaseHostId: db.kind === "shared" ? db.databaseHostId : "",
      dbName: db.kind === "shared" ? db.dbName : null,
      dbRole:
        db.kind === "shared" && db.dbRole !== db.dbName ? db.dbRole : null,
      passwordVariable:
        db.kind === "shared" ? db.passwordVariable : "DB_PASSWORD",
      serviceName: db.kind === "container" ? db.serviceName : null,
    },
    variables: setup.variables.map((v) => ({
      key: v.name,
      name: v.name,
      kind: v.kind,
      escrow: false,
      fromSource: v.copy === true,
      copyable: v.copy === true,
      value: v.value ?? "",
      required: issues.some(
        (i) => i.field === `variables.${v.name}` && i.code === "valueRequired"
      ),
    })),
    domain: {
      kind: d.kind,
      zoneId: d.kind === "tunnel" ? d.zoneId : "",
      label: d.kind === "tunnel" ? d.label : null,
      accessPolicyId:
        d.kind === "tunnel" ? (d.accessPolicyId ?? PUBLIC_POLICY) : "",
      entryPort: d.kind === "tunnel" ? String(d.entryPort) : null,
      hostname: d.kind === "external" ? d.hostname : "",
    },
  };
}

/** Placeholder for a port the preview has not suggested yet. */
const PROBE_ENTRY_PORT = 8100;

/**
 * The API input a draft stands for (unparsed: the schema is run by
 * `parseSetupInput`), plus the issues the browser can see by itself.
 */
export function buildSetupInput(
  draft: EnvironmentDraft,
  ctx: DraftContext
): { input: unknown; issues: SetupIssue[] } {
  const issues: SetupIssue[] = [];
  const db = draft.database;
  const database =
    db.kind === "shared"
      ? {
          kind: "shared" as const,
          databaseHostId: db.databaseHostId,
          dbName: db.dbName ?? defaultDatabaseName(ctx),
          // The role follows the database name until it is edited itself.
          dbRole: db.dbRole ?? db.dbName ?? defaultDatabaseName(ctx),
          passwordVariable: db.passwordVariable,
        }
      : db.kind === "container"
        ? {
            kind: "container" as const,
            serviceName: db.serviceName ?? defaultDbContainer(draft, ctx),
          }
        : { kind: db.kind };

  const d = draft.domain;
  const port = d.entryPort ?? ctx.suggestedEntryPort?.toString() ?? "";
  const domain =
    d.kind === "tunnel"
      ? {
          kind: "tunnel" as const,
          zoneId: d.zoneId || ctx.defaultZoneId,
          label: d.label ?? ctx.slug,
          accessPolicyId:
            d.accessPolicyId === PUBLIC_POLICY ? null : d.accessPolicyId,
          entryPort: port === "" && ctx.probe ? PROBE_ENTRY_PORT : Number(port),
        }
      : d.kind === "external"
        ? { kind: "external" as const, hostname: d.hostname }
        : { kind: "none" as const };
  if (d.kind === "tunnel" && d.accessPolicyId === "") {
    issues.push({ field: "domain.accessPolicyId", code: "required" });
  }
  if (d.kind === "tunnel" && port === "" && !ctx.probe) {
    issues.push({ field: "domain.entryPort", code: "required" });
  }

  const variables = draft.variables.map((v) => {
    const { input, missingValue } = variableInput(v);
    if (missingValue) {
      issues.push({ field: `variables.${v.name}`, code: "valueRequired" });
    }
    return input;
  });

  const input = {
    projectId: draft.projectId,
    appId: ctx.appId,
    name: draft.name,
    copyFromEnvironmentId: draft.copyFromEnvironmentId,
    server: { serverId: draft.serverId },
    targets: draft.targets.map((t) => ({
      componentKey: t.componentKey,
      sourceBranch: t.sourceBranch,
      autoDeploy: t.autoDeploy,
      deployDir: t.deployDir ?? defaultDeployDir(ctx),
      services: splitList(t.services),
      tagVariable: t.tagVariable,
      preStartCommand: t.preStartCommand.trim() || null,
      healthUrl: t.healthUrl.trim() || null,
      healthTimeoutSeconds: Number(t.healthTimeoutSeconds),
      backupBeforeDeploy: t.backupBeforeDeploy,
    })),
    services: effectiveServices(draft, ctx),
    entryService: ctx.entryService ?? undefined,
    database,
    variables,
    domain,
  };
  return { input, issues };
}

/** Where a zod path points in the form: the API's dotted field path. */
const fieldOf = (path: PropertyKey[]) => path.map(String).join(".");

/**
 * Runs the API schema over a built input. A failure is reported as issues
 * with the code `invalid` at the offending fields; a pass gives the input.
 */
export function parseSetupInput(
  input: unknown
):
  | { ok: true; input: EnvironmentSetupInput }
  | { ok: false; issues: SetupIssue[] } {
  const parsed = environmentSetupInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, input: parsed.data };
  const seen = new Set<string>();
  const issues: SetupIssue[] = [];
  for (const issue of parsed.error.issues) {
    const field = fieldOf(issue.path);
    if (seen.has(field)) continue;
    seen.add(field);
    issues.push({ field, code: "invalid" });
  }
  return { ok: false, issues };
}

/** The first issue code per field. */
export function issuesByField(
  issues: readonly SetupIssue[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[issue.field] ??= issue.code;
  return out;
}
