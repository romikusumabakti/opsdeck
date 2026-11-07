import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  appComponents,
  apps,
  databaseHosts,
  deployTargets,
  environmentDomains,
  environmentServices,
  environments,
  projects,
  servers,
} from "@/lib/db/schema";
import { COMPONENT_OTHER_APP_MESSAGE } from "@/lib/deploy/errors";
import { DOMAIN_ERRORS, pgErrorCode } from "@/lib/domains/errors";
import { getZone, saveDomainIn } from "@/lib/domains/repository";
import type { DomainInput } from "@/lib/domains/validation";
import { canProject, type ProjectRole } from "@/lib/permissions";
import {
  ProvisioningPlanError,
  type ProvisioningStepSpec,
  planProvisioning,
} from "@/lib/provisioning/plan";
import type {
  EnvironmentSetupInput,
  EnvironmentSetupTarget,
  SetupIssue,
} from "@/lib/setup/schema";
import {
  type EnvironmentInput,
  environmentInputSchema,
} from "@/lib/validation";
import { SHARED_DEPLOY_DIR_MESSAGE } from "@/lib/variables/errors";
import {
  deployDirInUse,
  listTemplates,
  listVariables as listVariableRows,
} from "@/lib/variables/repository";
import { CodedHTTPException, errorCode } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";
import { insertDeployTargetIn, targetError } from "@/server/services/deploys";
import { validateDomainBinding } from "@/server/services/environment-domains";
import {
  type EnvironmentBinding,
  type EnvironmentServiceValues,
  environmentNameTaken,
  insertEnvironmentIn,
  uniqueEnvSlug,
  validateNewEnvironment,
} from "@/server/services/environments";
import { freeEntryPort } from "@/server/services/preflight";
import { startProvisioning } from "@/server/services/provisioning";
import {
  insertVariablesIn,
  type PlannedVariable,
  planEnvironmentVariables,
  variableIssueError,
} from "@/server/services/variables";

/**
 * The setup wizard's environment: one request that creates an environment of
 * an app with its services, deploy targets, variables, database binding and
 * domain, then starts its provisioning run.
 *
 * The rules are the existing ones, run by the same functions the single-row
 * APIs use (validateNewEnvironment, validateDomainBinding, the variables
 * rules, the target rules). The preview runs them all and reports each
 * refusal as an issue `{ field, code }` with the code the create would refuse
 * with; the create runs them in the same order, throws the first refusal, and
 * writes every row in one transaction, so a refused setup leaves nothing.
 *
 * Who: maintainers of the target project (environment:create, plus the deploy
 * and variable rights the target, variable and domain APIs ask for); a
 * contributor (QA) gets 403. Copying from another environment needs project
 * read on it (404 otherwise); its plain and secret values are copied only for
 * a caller who may read its variables (variable:read), server-side, and never
 * appear in a response. Generated and escrowed values are never copied.
 */

const SETUP_PERMISSIONS = {
  environment: ["create"],
  deploy: ["configure", "run"],
  variable: ["write"],
} as const;

// Refusals only the setup has, by code (the others are the reused rules').
const SETUP_ERRORS = {
  appNotFound: [404, "App not found"],
  serverNotFound: [404, "Server not found"],
  copySourceOtherApp: [400, "The copy source deploys another app"],
  environmentNameTaken: [
    409,
    "The project already has an environment of this name",
  ],
  targetMissing: [400, "Every component of the app needs a deploy target"],
  sharedDeployDir: [409, SHARED_DEPLOY_DIR_MESSAGE],
  passwordVariableMissing: [
    400,
    "The database password variable must be a secret or generated variable of the environment",
  ],
  cloudflareUnavailable: [502, "The Cloudflare account could not be read"],
} as const satisfies Record<string, readonly [400 | 404 | 409 | 502, string]>;

type SetupErrorCode = keyof typeof SETUP_ERRORS;

function setupError(code: SetupErrorCode): CodedHTTPException {
  const [status, message] = SETUP_ERRORS[code];
  return new CodedHTTPException(status, code, message);
}

/**
 * Runs checks in one of two modes: `collect` (the preview) records a coded
 * refusal as an issue and goes on, `throw` (the create) rethrows the first.
 * A refusal without a code (permission, a bug) always propagates.
 */
class Checks {
  readonly issues: SetupIssue[] = [];
  constructor(private readonly mode: "collect" | "throw") {}

  refuse(field: string, error: CodedHTTPException): void {
    if (this.mode === "throw") throw error;
    this.issues.push({ field, code: error.code });
  }

  /** Runs `fn`; a coded refusal becomes an issue at `fieldOf(code)`. */
  async run<T>(
    fieldOf: (code: string) => string,
    fn: () => Promise<T>
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      const code = errorCode(error);
      if (!code || this.mode === "throw") throw error;
      this.issues.push({ field: fieldOf(code), code });
      return undefined;
    }
  }
}

type Caller = {
  userId: string;
  orgRole: string | null | undefined;
  projectRole: ProjectRole;
};

type CopySource = {
  id: string;
  appId: string | null;
  canReadVariables: boolean;
};

async function authorize(
  input: EnvironmentSetupInput
): Promise<{ caller: Caller; source: CopySource | null }> {
  const { session, role } = await requireProjectPermission(
    { projectId: input.projectId },
    SETUP_PERMISSIONS
  );
  const caller = {
    userId: session.user.id,
    orgRole: session.user.role,
    projectRole: role,
  };
  if (!input.copyFromEnvironmentId) return { caller, source: null };
  const { role: sourceRole } = await requireProjectPermission(
    { environmentId: input.copyFromEnvironmentId },
    { project: ["read"] }
  );
  const [row] = await db
    .select({ appId: environments.appId })
    .from(environments)
    .where(eq(environments.id, input.copyFromEnvironmentId))
    .limit(1);
  if (!row) throw new HTTPException(404, { message: "Not Found" });
  return {
    caller,
    source: {
      id: input.copyFromEnvironmentId,
      appId: row.appId,
      canReadVariables: canProject(sourceRole, { variable: ["read"] }),
    },
  };
}

/** The environment row and service bindings the setup input stands for. */
function environmentInputOf(
  input: EnvironmentSetupInput,
  url: string | null
): EnvironmentInput {
  const serverId = input.server.serverId;
  // The env's backend and frontend services are the targets' first two
  // compose services: service control and logs act on them by name.
  const names = [...new Set(input.targets.flatMap((t) => t.services))];
  const [backend = "", frontend] = names;
  const shared = input.database.kind === "shared" ? input.database : null;
  return environmentInputSchema.parse({
    projectId: input.projectId,
    name: input.name,
    kind: input.kind ?? null,
    ownerId: input.ownerId ?? null,
    host: null,
    url,
    hasDatabase: shared !== null,
    ...(shared && {
      dbKind: "shared",
      databaseHostId: shared.databaseHostId,
      dbName: shared.dbName,
      dbRole: shared.dbRole,
      dbPasswordVariable: shared.passwordVariable,
    }),
    backendServerId: serverId,
    backendServiceType: "docker",
    backendServiceName: backend,
    hasFrontend: frontend !== undefined,
    ...(frontend !== undefined && {
      frontendServerId: serverId,
      frontendServiceType: "docker",
      frontendServiceName: frontend,
    }),
  });
}

/** The db service row of a `container` binding (none for the other kinds). */
function containerService(
  input: EnvironmentSetupInput
): EnvironmentServiceValues | null {
  if (input.database.kind !== "container") return null;
  return {
    role: "db",
    serverId: input.server.serverId,
    serviceType: "docker",
    serviceName: input.database.serviceName,
    dbType: "postgres",
    dbKind: "container",
  };
}

function domainUrl(domain: EnvironmentSetupInput["domain"], zone?: string) {
  if (domain.kind === "external") return `https://${domain.hostname}`;
  if (domain.kind === "tunnel" && zone) {
    return `https://${domain.label}.${zone.toLowerCase()}`;
  }
  return null;
}

// Where a refusal of validateNewEnvironment points in the setup input. The
// service names come from the targets unless the database container is the
// unprefixed or reserved one.
function environmentField(
  input: EnvironmentSetupInput,
  projectKey: string,
  code: string
): string {
  const container =
    input.database.kind === "container" ? input.database.serviceName : null;
  const prefix = `${projectKey.toLowerCase()}-`;
  switch (code) {
    case "placementForbidden":
      return "server.serverId";
    case "placementServiceName":
      return container !== null &&
        !(container.startsWith(prefix) && container.length > prefix.length)
        ? "database.serviceName"
        : "targets.0.services";
    case "placementServiceInUse":
    case "placementDatabaseHostContainer":
      return container !== null ? "database.serviceName" : "targets.0.services";
    case "databaseHostNotFound":
      return "database.databaseHostId";
    case "placementDatabaseName":
    case "sharedDatabaseNamePrefix":
    case "placementDatabaseInUse":
      return "database.dbName";
    case "environmentOwnerIneligible":
      return "ownerId";
    default:
      return "name";
  }
}

function domainField(domain: EnvironmentSetupInput["domain"], code: string) {
  switch (code) {
    case "domainHostnameTaken":
      return domain.kind === "tunnel" ? "domain.label" : "domain.hostname";
    case "domainExternalInZone":
      return "domain.hostname";
    case "domainPortForbidden":
    case "domainPortInUse":
      return "domain.entryPort";
    case "domainUnknownZone":
      return "domain.zoneId";
    case "domainPublicForbidden":
    case "domainUnknownPolicy":
    case "cloudflareUnavailable":
      return "domain.accessPolicyId";
    default:
      return "domain.kind";
  }
}

type Prepared = {
  caller: Caller;
  projectKey: string;
  projectName: string;
  serverName: string;
  slug: string;
  environment: EnvironmentInput;
  extraServices: EnvironmentServiceValues[];
  variables: PlannedVariable[];
  domain: Awaited<ReturnType<typeof validateDomainBinding>> | null;
  databaseLabel: string | null;
};

/**
 * Every check of a setup, in the create's order. Returns the issues and,
 * when the inputs the writes need were all resolved, what to write. In
 * `throw` mode the first refusal is thrown instead.
 */
async function checkSetup(
  input: EnvironmentSetupInput,
  mode: "collect" | "throw"
): Promise<{ issues: SetupIssue[]; prepared: Prepared | null; slug: string }> {
  const { caller, source } = await authorize(input);
  const checks = new Checks(mode);
  const serverId = input.server.serverId;

  const [project] = await db
    .select({ key: projects.key, name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: "Not Found" });

  const [app] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (!app) checks.refuse("appId", setupError("appNotFound"));
  const appComponentKeys = app
    ? (
        await db
          .select({ componentKey: appComponents.componentKey })
          .from(appComponents)
          .where(eq(appComponents.appId, app.id))
      ).map((c) => c.componentKey)
    : [];

  const [server] = await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) checks.refuse("server.serverId", setupError("serverNotFound"));

  if (source && source.appId !== input.appId) {
    checks.refuse("copyFromEnvironmentId", setupError("copySourceOtherApp"));
  }

  if (await environmentNameTaken(input.projectId, input.name)) {
    checks.refuse("name", setupError("environmentNameTaken"));
  }

  // Deploy targets: the app's components, once each, in dirs of their own
  // (the wizard's environments have a managed `.env`).
  const seen = new Set<string>();
  for (const [i, target] of input.targets.entries()) {
    const field = `targets.${i}.componentKey`;
    if (app && !appComponentKeys.includes(target.componentKey)) {
      const [other] = await db
        .select({ key: appComponents.componentKey })
        .from(appComponents)
        .where(eq(appComponents.componentKey, target.componentKey))
        .limit(1);
      checks.refuse(
        field,
        other
          ? new CodedHTTPException(
              409,
              "componentOtherApp",
              COMPONENT_OTHER_APP_MESSAGE
            )
          : targetError("componentNotFound")
      );
    } else if (seen.has(target.componentKey)) {
      checks.refuse(field, targetError("targetDuplicate"));
    }
    seen.add(target.componentKey);
    if (server && (await deployDirInUse(serverId, target.deployDir))) {
      checks.refuse(`targets.${i}.deployDir`, setupError("sharedDeployDir"));
    }
  }
  if (app && appComponentKeys.some((key) => !seen.has(key))) {
    checks.refuse("targets", setupError("targetMissing"));
  }

  // The zone's name gives the environment its URL ({url} placeholders).
  const zoneName =
    input.domain.kind === "tunnel"
      ? (await getZone(input.domain.zoneId))?.name
      : undefined;
  const url = domainUrl(input.domain, zoneName);
  const environment = environmentInputOf(input, url);
  const container = containerService(input);
  const extraBindings: EnvironmentBinding[] = container
    ? [{ serverId: container.serverId, serviceName: container.serviceName }]
    : [];
  const validated = await checks.run(
    (code) => environmentField(input, project.key, code),
    () =>
      validateNewEnvironment(
        environment,
        { orgRole: caller.orgRole, projectRole: caller.projectRole },
        extraBindings
      )
  );

  const slug = await uniqueEnvSlug(input.projectId, input.name);
  const [templates, sourceVariables] = await Promise.all([
    app ? listTemplates(app.id) : Promise.resolve([]),
    source ? listVariableRows(source.id) : Promise.resolve(null),
  ]);
  const plannedVariables = planEnvironmentVariables({
    entries: input.variables,
    templates,
    source: sourceVariables,
    canReadSource: source?.canReadVariables ?? false,
    tagNames: [...new Set(input.targets.map((t) => t.tagVariable))],
    placeholders: { host: null, url, envSlug: slug },
  });
  for (const issue of plannedVariables.issues) {
    checks.refuse(`variables.${issue.name}`, variableIssueError(issue));
  }
  if (input.database.kind === "shared") {
    const name = input.database.passwordVariable;
    const refused = plannedVariables.issues.some((i) => i.name === name);
    const variable = plannedVariables.variables.find((v) => v.name === name);
    if (!refused && (!variable || variable.kind === "plain")) {
      checks.refuse(
        "database.passwordVariable",
        setupError("passwordVariableMissing")
      );
    }
  }

  const domainInput: DomainInput | null =
    input.domain.kind === "none" ? null : input.domain;
  const domain = domainInput
    ? await checks.run(
        (code) => domainField(input.domain, code),
        async () => {
          try {
            return await validateDomainBinding(caller.orgRole, domainInput, {
              deployServerId: async () => serverId,
            });
          } catch (error) {
            // The Access policy lookup failed (no account, an outage).
            if (error instanceof HTTPException && !errorCode(error)) {
              if (mode === "throw") throw error;
              throw setupError("cloudflareUnavailable");
            }
            throw error;
          }
        }
      )
    : null;

  let databaseLabel: string | null = null;
  if (input.database.kind === "shared") {
    const [host] = await db
      .select({ label: databaseHosts.label })
      .from(databaseHosts)
      .where(eq(databaseHosts.id, input.database.databaseHostId))
      .limit(1);
    databaseLabel = host?.label ?? null;
  }

  const ready = domainInput === null || domain !== undefined;
  return {
    issues: checks.issues,
    slug,
    prepared:
      ready && validated && server
        ? {
            caller,
            projectKey: project.key,
            projectName: project.name,
            serverName: server.name,
            slug,
            environment: validated,
            extraServices: container ? [container] : [],
            variables: plannedVariables.variables,
            domain: domain ?? null,
            databaseLabel,
          }
        : null,
  };
}

/** The provisioning plan of a prepared setup; target ids are component keys. */
function setupPlan(
  input: EnvironmentSetupInput,
  prepared: Prepared,
  targetIds: string[]
): ProvisioningStepSpec[] {
  const db =
    input.database.kind === "shared"
      ? {
          dbKind: "shared",
          databaseHostId: input.database.databaseHostId,
          dbName: input.database.dbName,
          dbRole: input.database.dbRole,
          dbPasswordVariable: input.database.passwordVariable,
        }
      : null;
  const domain = prepared.domain;
  return planProvisioning({
    targets: input.targets.map((t, i) => ({
      id: targetIds[i] ?? t.componentKey,
      serverId: input.server.serverId,
      deployDir: t.deployDir,
      sourceBranch: t.sourceBranch,
    })),
    db,
    domain: domain && {
      ...domain.write,
      originHost: domain.originHost ?? null,
      entryPort: domain.entryPort ?? null,
    },
  });
}

/** The rows a setup writes, in words for the Review. */
async function describeCreates(
  input: EnvironmentSetupInput,
  prepared: Prepared
): Promise<string[]> {
  const t = await getServerTranslator("environmentSetup");
  const lines = [
    t("creates.environment", {
      name: input.name,
      project: prepared.projectName,
    }),
    ...input.targets.map((target) =>
      t("creates.target", {
        component: target.componentKey,
        server: prepared.serverName,
        deployDir: target.deployDir,
      })
    ),
  ];
  if (input.database.kind === "shared") {
    lines.push(
      t("creates.databaseShared", {
        database: input.database.dbName,
        host: prepared.databaseLabel ?? "",
      })
    );
  } else if (input.database.kind === "container") {
    lines.push(
      t("creates.databaseContainer", {
        container: input.database.serviceName,
        server: prepared.serverName,
      })
    );
  }
  const variables = prepared.variables;
  if (variables.length > 0) {
    lines.push(
      t("creates.variables", {
        count: variables.length,
        generated: variables.filter(
          (v) =>
            v.kind === "generated" &&
            (v.origin === "generated" || v.origin === "template")
        ).length,
        copied: variables.filter(
          (v) => v.origin === "copied" && v.kind === "secret"
        ).length,
      })
    );
  }
  if (prepared.domain) {
    lines.push(
      t("creates.domain", { hostname: prepared.domain.write.hostname })
    );
  }
  return lines;
}

export type SetupPreview = {
  issues: SetupIssue[];
  plan: ProvisioningStepSpec[];
  creates: string[];
  suggestedEntryPort: number | null;
  slug: string;
};

/**
 * Runs every check of the create without writing. `plan` and `creates` are
 * empty while a check the writes depend on fails; `suggestedEntryPort` is the
 * server's lowest free port by its stored preflight (other environments'
 * entry ports excluded), null without a preflight.
 */
export async function previewEnvironmentSetup(
  input: EnvironmentSetupInput
): Promise<SetupPreview> {
  const { issues, prepared, slug } = await checkSetup(input, "collect");
  let plan: ProvisioningStepSpec[] = [];
  if (prepared) {
    try {
      plan = setupPlan(
        input,
        prepared,
        input.targets.map((t) => t.componentKey)
      );
    } catch (error) {
      if (!(error instanceof ProvisioningPlanError)) throw error;
      issues.push({ field: "plan", code: error.code });
    }
  }
  const suggestedEntryPort = await freeEntryPort(input.server.serverId);
  return {
    issues,
    plan,
    creates: prepared ? await describeCreates(input, prepared) : [],
    suggestedEntryPort,
    slug,
  };
}

export type SetupCreated = {
  environmentId: string;
  projectKey: string;
  envSlug: string;
  runId: string | null;
  /** Why provisioning did not start; it can be started from the Deploys page. */
  provisioningError?: string;
};

// A unique index the transaction ran into: a concurrent setup or edit took
// the name, a target or the hostname after the checks.
function uniqueRefusal(error: unknown): CodedHTTPException | null {
  if (pgErrorCode(error) !== "23505") return null;
  const e = error as {
    constraint_name?: string;
    cause?: { constraint_name?: string };
  };
  const constraint = e.constraint_name ?? e.cause?.constraint_name ?? "";
  if (constraint.startsWith("environments_project_")) {
    return setupError("environmentNameTaken");
  }
  if (constraint === "deploy_targets_environment_component_idx") {
    return targetError("targetDuplicate");
  }
  if (constraint === "environment_domains_hostname_key") {
    return new CodedHTTPException(
      409,
      "domainHostnameTaken",
      DOMAIN_ERRORS.domainHostnameTaken
    );
  }
  return null;
}

/**
 * Runs the preview's checks, refusing with the first, then writes the
 * environment, its services, targets, variables and domain in one
 * transaction, records `environment.setup` (names only) and starts the
 * provisioning run. A failure to start provisioning keeps the environment:
 * `runId` is null and `provisioningError` says why.
 */
export async function createEnvironmentSetup(
  input: EnvironmentSetupInput
): Promise<SetupCreated> {
  const { prepared } = await checkSetup(input, "throw");
  // Every check passed, so everything is resolved.
  if (!prepared) throw new Error("Setup checks passed without a result");
  const { caller, environment } = prepared;

  let created: { id: string; name: string; slug: string };
  try {
    created = await db.transaction(async (tx) => {
      const env = await insertEnvironmentIn(tx, environment, {
        slug: prepared.slug,
        ownerId: environment.ownerId ?? caller.userId,
        extra: {
          appId: input.appId,
          envFileManaged: true,
          entryPort: prepared.domain?.entryPort ?? null,
        },
        extraServices: prepared.extraServices,
      });
      for (const target of input.targets) {
        await insertDeployTargetIn(tx, targetRow(env.id, input, target));
      }
      await insertVariablesIn(tx, env.id, prepared.variables, caller.userId);
      if (prepared.domain) {
        await saveDomainIn(tx, env.id, prepared.domain.write);
      }
      return env;
    });
  } catch (error) {
    const refusal = uniqueRefusal(error);
    if (refusal) throw refusal;
    throw error;
  }

  // Names only: never a value. The environment exists; a lost feed entry is
  // not worth failing the request.
  try {
    await recordActivity({
      actorId: caller.userId,
      action: "environment.setup",
      entityType: "environment",
      entityId: created.id,
      data: {
        environment: created.name,
        project: prepared.projectKey,
        components: input.targets.map((t) => t.componentKey).join(", "),
        variables: prepared.variables
          .map((v) => v.name)
          .sort()
          .join(", "),
      },
    });
  } catch (error) {
    console.error("Failed to record setup activity:", error);
  }

  const result: SetupCreated = {
    environmentId: created.id,
    projectKey: prepared.projectKey,
    envSlug: created.slug,
    runId: null,
  };
  try {
    result.runId = (await startProvisioning(created.id)).runId;
  } catch (error) {
    console.error(`Provisioning of new environment ${created.id}:`, error);
    result.provisioningError = provisioningErrorCode(error);
  }
  return result;
}

function targetRow(
  environmentId: string,
  input: EnvironmentSetupInput,
  target: EnvironmentSetupTarget
) {
  return {
    ...target,
    environmentId,
    serverId: input.server.serverId,
    preStartCommand: target.preStartCommand ?? null,
    healthUrl: target.healthUrl ?? null,
  };
}

// A plan refusal is its own code (startProvisioning's 422 message); a run
// already active or any other failure (the queue) has one each.
function provisioningErrorCode(error: unknown): string {
  if (error instanceof HTTPException) {
    if (error.status === 422) return error.message;
    if (error.status === 409) return "provisioningRunning";
  }
  return "provisioningStartFailed";
}

export type CopySourceView = {
  environment: { id: string; name: string; projectId: string };
  serverId: string | null;
  targets: EnvironmentSetupTarget[];
  database: {
    kind: "shared" | "container" | "external" | "none";
    databaseHostId: string | null;
  };
  domain: {
    kind: "none" | "tunnel" | "external";
    zoneId: string | null;
    accessPolicyId: string | null;
  };
  variables: {
    name: string;
    kind: "plain" | "secret" | "generated";
    escrow: boolean;
    hasValue: boolean;
    copyable: boolean;
    value?: string;
  }[];
};

/**
 * What "copy from" prefills: the source's targets, database kind and host,
 * domain kind, zone and Access policy, and its variables by name. Never a
 * database or host name, a hostname, an entry port or a secret value; plain
 * values only for a caller who may read the source's variables. `copyable`
 * says whether the create would copy the value for this caller: never for
 * generated or escrowed variables. Project read on the source, else 404.
 */
export async function getCopySource(
  environmentId: string
): Promise<CopySourceView> {
  const { role } = await requireProjectPermission(
    { environmentId },
    { project: ["read"] }
  );
  const canRead = canProject(role, { variable: ["read"] });
  const [env] = await db
    .select({
      id: environments.id,
      name: environments.name,
      projectId: environments.projectId,
    })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!env) throw new HTTPException(404, { message: "Not Found" });

  const [targets, [dbService], [domain], variables] = await Promise.all([
    db
      .select()
      .from(deployTargets)
      .where(eq(deployTargets.environmentId, environmentId))
      .orderBy(asc(deployTargets.createdAt), asc(deployTargets.id)),
    db
      .select({
        dbKind: environmentServices.dbKind,
        databaseHostId: environmentServices.databaseHostId,
      })
      .from(environmentServices)
      .where(
        and(
          eq(environmentServices.environmentId, environmentId),
          eq(environmentServices.role, "db")
        )
      )
      .limit(1),
    db
      .select({
        kind: environmentDomains.kind,
        zoneId: environmentDomains.zoneId,
        accessPolicyId: environmentDomains.accessPolicyId,
      })
      .from(environmentDomains)
      .where(eq(environmentDomains.environmentId, environmentId))
      .limit(1),
    listVariableRows(environmentId),
  ]);

  return {
    environment: env,
    serverId: targets[0]?.serverId ?? null,
    targets: targets.map((t) => ({
      componentKey: t.componentKey,
      sourceBranch: t.sourceBranch,
      autoDeploy: t.autoDeploy,
      deployDir: t.deployDir,
      services: t.services,
      tagVariable: t.tagVariable,
      preStartCommand: t.preStartCommand,
      healthUrl: t.healthUrl,
      healthTimeoutSeconds: t.healthTimeoutSeconds,
      backupBeforeDeploy: t.backupBeforeDeploy,
    })),
    database: dbService
      ? {
          // A binding from before database kinds is one the Panel does not
          // manage.
          kind: dbService.dbKind ?? "external",
          databaseHostId: dbService.databaseHostId,
        }
      : { kind: "none", databaseHostId: null },
    domain: domain
      ? {
          kind: domain.kind,
          zoneId: domain.zoneId,
          accessPolicyId: domain.accessPolicyId,
        }
      : { kind: "none", zoneId: null, accessPolicyId: null },
    variables: variables.map((v) => ({
      name: v.name,
      kind: v.kind,
      escrow: v.escrow,
      hasValue: v.value !== "",
      copyable: canRead && !v.escrow && v.kind !== "generated",
      ...(canRead && v.kind === "plain" ? { value: v.value } : {}),
    })),
  };
}
