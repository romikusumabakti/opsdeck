import { and, asc, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { listApps } from "@/lib/apps";
import {
  orgGrantAllows,
  orgGrantRole,
  requireProjectPermission,
} from "@/lib/authz";
import {
  bundleImageFor,
  type RegisterComponentInput,
  registerAppSchema,
  repoRepresentative,
} from "@/lib/ci/registration";
import { CiProviderError, type CiRepo } from "@/lib/ci/types";
import { db } from "@/lib/db";
import {
  databaseHosts,
  environmentServices,
  environments,
  projects,
  servers,
} from "@/lib/db/schema";
import { branchSchema } from "@/lib/deploy/validation";
import { listZones } from "@/lib/domains/repository";
import {
  canOrg,
  canPlaceEnvironment,
  type ProjectRole,
} from "@/lib/permissions";
import {
  type NewEnvironmentContext,
  type NewEnvironmentInput,
  type NewEnvironmentPlan,
  newEnvironmentInputSchema,
  resolveNewEnvironment,
} from "@/lib/setup/new-environment";
import type { SetupIssue } from "@/lib/setup/schema";
import {
  badRequest,
  CodedHTTPException,
  errorCode,
  notFound,
} from "@/server/errors";
import {
  type AppWithComponents,
  addSetupComponents,
  type EnvironmentBranches,
  ensureComponentBranch,
  type PipelineFileFailure,
  registerSetupApp,
  requireRegistrant,
  triggerComponentBuild,
} from "@/server/services/apps";
import {
  getProviderForConnection,
  listConnectionOptions,
} from "@/server/services/ci-connections";
import { listProjectAccessPolicies } from "@/server/services/environment-domains";
import {
  createEnvironmentSetup,
  getCopySource,
  previewEnvironmentSetup,
  SETUP_PERMISSIONS,
  type SetupCreated,
  type SetupPreview,
} from "@/server/services/environment-setup";
import { uniqueEnvSlug } from "@/server/services/environments";
import { freeEntryPort } from "@/server/services/preflight";
import { detectComponentRepo } from "@/server/services/setup-detect";

/**
 * The New environment page's server side: reads the context of a short input
 * (lib/setup/new-environment) from the database and repo detection, resolves
 * it into a setup, and previews or creates that setup. Create registers the
 * repos the plan lists (a new app, or more components of the existing one),
 * adds the environment's branch to generated components, runs the setup,
 * makes the first server choice the project default and starts the first
 * builds, which deploy when they land (`deploy_next_build`).
 *
 * Who: the setup's callers (environment:create plus the deploy and variable
 * rights it asks for); a QA gets 403 before anything is read.
 */

/** Stands in for an app the create registers first (the preview's check). */
const UNREGISTERED_APP_ID = "00000000-0000-0000-0000-000000000000";
/** The Access policy a new address is behind unless the copy source has one. */
const DEFAULT_ACCESS_POLICY_NAME = "DSS Internal";
const REPO_SEARCH_LIMIT = 50;

// The unique-index races of a create (and the same checks seen just before
// it), under the codes the New environment page knows.
const TAKEN_CODES: Record<string, "nameTaken" | "domainTaken"> = {
  environmentNameTaken: "nameTaken",
  environmentSlugTaken: "nameTaken",
  domainHostnameTaken: "domainTaken",
};

type Caller = {
  orgRole: string | null | undefined;
  projectRole: ProjectRole;
};

function parseInput(raw: unknown): NewEnvironmentInput {
  const parsed = newEnvironmentInputSchema.safeParse(raw);
  if (!parsed.success) badRequest("Invalid request", "invalidInput");
  return parsed.data;
}

/**
 * The setup's project permissions; choosing a pipeline's mode or build spec
 * (`advanced.pipelines`) also needs org integration:manage.
 */
async function authorize(input: NewEnvironmentInput): Promise<Caller> {
  const { session, role } = await requireProjectPermission(
    { projectId: input.projectId },
    SETUP_PERMISSIONS
  );
  if (
    (input.advanced?.pipelines?.length ?? 0) > 0 &&
    !orgGrantAllows(session, { integration: ["manage"] })
  ) {
    throw new CodedHTTPException(
      403,
      "pipelineForbidden",
      "Choosing a pipeline needs integration:manage"
    );
  }
  return { orgRole: orgGrantRole(session), projectRole: role };
}

/** Runs a CI server call, turning its failure into a 502. */
async function ciStep<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CiProviderError) {
      throw new CodedHTTPException(
        502,
        "ciUnavailable",
        `Reading the CI server failed: ${error.message}`
      );
    }
    throw error;
  }
}

type RegistryComponent = AppWithComponents["components"][number] & {
  app: AppWithComponents;
};

function registryComponents(registry: AppWithComponents[]) {
  return registry.flatMap((app) =>
    app.components.map((c): RegistryComponent => ({ ...c, app }))
  );
}

/**
 * The component a CI repository builds, if any; for a repository building
 * several, its non-artifact one (see repoRepresentative).
 */
function componentOfRepo(
  components: RegistryComponent[],
  ciConnectionId: string,
  repo: { fullName: string; ciRepoId?: string }
): RegistryComponent | undefined {
  return repoRepresentative(
    components.filter(
      (c) =>
        c.ciConnectionId === ciConnectionId &&
        ((!!repo.ciRepoId && c.ciRepoId === repo.ciRepoId) ||
          c.repoFullName === repo.fullName)
    )
  );
}

/** Database, role and user names a new shared database must not overlap. */
async function takenDatabaseNames(
  hostId: string | null,
  sourceId: string | null
): Promise<string[]> {
  const columns = {
    dbName: environmentServices.dbName,
    dbRole: environmentServices.dbRole,
    dbUser: environmentServices.dbUser,
  };
  const [onHost, ofSource] = await Promise.all([
    hostId
      ? db
          .select(columns)
          .from(environmentServices)
          .where(eq(environmentServices.databaseHostId, hostId))
      : [],
    // The copy source's own, wherever it lives (canary bug 2).
    sourceId
      ? db
          .select(columns)
          .from(environmentServices)
          .where(
            and(
              eq(environmentServices.environmentId, sourceId),
              eq(environmentServices.role, "db")
            )
          )
      : [],
  ]);
  const names = [...onHost, ...ofSource].flatMap((r) =>
    [r.dbName, r.dbRole, r.dbUser].filter((n): n is string => !!n)
  );
  return [...new Set(names)];
}

/**
 * The copy source's Access policy when the caller may use it, else the one
 * named DEFAULT_ACCESS_POLICY_NAME; null when neither is there or the
 * Cloudflare account cannot be read (the resolver then asks for one).
 */
async function defaultAccessPolicy(
  projectId: string,
  sourcePolicyId: string | null
): Promise<string | null> {
  try {
    const policies = await listProjectAccessPolicies(projectId);
    return (
      policies.find((p) => p.id === sourcePolicyId)?.id ??
      policies.find(
        (p) => p.name.toLowerCase() === DEFAULT_ACCESS_POLICY_NAME.toLowerCase()
      )?.id ??
      null
    );
  } catch (error) {
    // A Cloudflare outage (or a network error out of callCloudflare) must
    // not fail the preview: the resolver reports the missing policy.
    if (!(error instanceof HTTPException)) {
      console.error("Reading the Access policies failed:", error);
    }
    return null;
  }
}

function repoNotFound(repoFullName: string): never {
  throw new CodedHTTPException(
    404,
    "repoNotFound",
    `The CI server does not list ${repoFullName}`
  );
}

// Detection's refusals by status: an unknown connection or repo, one whose
// files the Panel cannot read, a CI server or forge that failed.
const DETECTION_CODES: Record<number, [string, string]> = {
  400: ["repoUnreadable", "The Panel cannot read this repository's files"],
  404: ["repoNotFound", "The CI server does not list this repository"],
  502: ["ciUnavailable", "Reading the repository failed"],
};

/** detectComponentRepo, with a stable code on each of its refusals. */
async function detect(
  ciConnectionId: string,
  repoFullName: string,
  branch: string
) {
  try {
    return await detectComponentRepo(ciConnectionId, repoFullName, branch);
  } catch (error) {
    const coded =
      error instanceof HTTPException && !errorCode(error)
        ? DETECTION_CODES[error.status]
        : undefined;
    if (!coded) throw error;
    const [code, fallback] = coded;
    throw new CodedHTTPException(
      (error as HTTPException).status as 400 | 404 | 502,
      code,
      (error as HTTPException).message || fallback
    );
  }
}

/** Everything the resolver needs, read for this caller. */
async function loadContext(
  input: NewEnvironmentInput,
  caller: Caller
): Promise<NewEnvironmentContext> {
  const [[project], serverRows, hostRows, registry, zones, slug] =
    await Promise.all([
      db
        .select({
          id: projects.id,
          key: projects.key,
          defaultServerId: projects.defaultServerId,
        })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1),
      db
        .select({
          id: servers.id,
          name: servers.name,
          placement: servers.placement,
        })
        .from(servers)
        .orderBy(asc(servers.name)),
      db
        .select({ id: databaseHosts.id, serverId: databaseHosts.serverId })
        .from(databaseHosts)
        .orderBy(asc(databaseHosts.label)),
      listApps(),
      listZones(),
      uniqueEnvSlug(input.projectId, input.name),
    ]);
  if (!project) notFound();

  const placeable = serverRows
    .filter((s) =>
      canPlaceEnvironment(
        caller.orgRole,
        caller.projectRole,
        s.placement,
        s.id === project.defaultServerId
      )
    )
    .map((s) => ({
      ...s,
      databaseHostId: hostRows.find((h) => h.serverId === s.id)?.id ?? null,
    }));
  const components = registryComponents(registry);

  // The copy source, by the copy rules (getCopySource filters the variables).
  const source = input.copyFromEnvironmentId
    ? await getCopySource(input.copyFromEnvironmentId)
    : null;
  const [sourceRow] = source
    ? await db
        .select({ appId: environments.appId })
        .from(environments)
        .where(eq(environments.id, source.environment.id))
        .limit(1)
    : [];

  // Each picked repo once, detected on its branch.
  const picked = input.repos.filter(
    (r, i) =>
      input.repos.findIndex(
        (o) =>
          o.repoFullName === r.repoFullName &&
          o.ciConnectionId === r.ciConnectionId
      ) === i
  );
  const repos: NewEnvironmentContext["repos"] = await Promise.all(
    picked.map(async (r) => {
      const component = componentOfRepo(components, r.ciConnectionId, {
        fullName: r.repoFullName,
      });
      return {
        repoFullName: r.repoFullName,
        ciConnectionId: r.ciConnectionId,
        detection: await detect(r.ciConnectionId, r.repoFullName, r.branch),
        component: component
          ? {
              componentKey: component.componentKey,
              appId: component.appId,
              appKey: component.app.appKey,
            }
          : null,
      };
    })
  );
  // A copy without picked repos: the source's components, detected where
  // their repos can be read (detection only fills names).
  if (input.repos.length === 0 && source) {
    for (const target of source.targets) {
      const component = components.find(
        (c) => c.componentKey === target.componentKey
      );
      if (!component) continue;
      try {
        repos.push({
          repoFullName: component.repoFullName,
          ciConnectionId: component.ciConnectionId,
          detection: await detect(
            component.ciConnectionId,
            component.repoFullName,
            target.sourceBranch
          ),
          component: {
            componentKey: component.componentKey,
            appId: component.appId,
            appKey: component.app.appKey,
          },
        });
      } catch (error) {
        if (!(error instanceof HTTPException)) throw error;
      }
    }
  }

  const sourceApp = registry.find((a) => a.id === sourceRow?.appId);
  const firstKnown = repos.find((r) => r.component)?.component;
  const app = sourceApp
    ? { id: sourceApp.id, key: sourceApp.appKey }
    : firstKnown
      ? { id: firstKnown.appId, key: firstKnown.appKey }
      : null;

  const server = placeable.find(
    (s) => s.id === (input.serverId ?? project.defaultServerId)
  );
  const advancedDb = input.advanced?.database;
  const hostId =
    (advancedDb?.kind === "shared" ? advancedDb.databaseHostId : undefined) ??
    server?.databaseHostId ??
    null;
  const wantsPolicy = input.address !== null && !input.advanced?.domain;
  const [suggestedPort, existingDbNames, defaultAccessPolicyId] =
    await Promise.all([
      server ? freeEntryPort(server.id) : null,
      takenDatabaseNames(hostId, source?.environment.id ?? null),
      wantsPolicy
        ? defaultAccessPolicy(
            input.projectId,
            source?.domain.accessPolicyId ?? null
          )
        : null,
    ]);

  return {
    project,
    servers: placeable,
    repos,
    app,
    slug,
    copySource: source,
    suggestedPort,
    defaultZoneId: source?.domain.zoneId ?? zones[0]?.id ?? null,
    defaultAccessPolicyId,
    zones,
    existingDbNames,
    takenComponentKeys: components.map((c) => c.componentKey),
    takenAppKeys: registry.map((a) => a.appKey),
  };
}

/**
 * The setup preview of a resolved plan. Before the create registers them, the
 * app and its new components do not exist: those two refusals are dropped.
 */
async function previewPlan(
  plan: NewEnvironmentPlan,
  ctx: NewEnvironmentContext
): Promise<SetupPreview> {
  const preview = await previewEnvironmentSetup({
    ...plan.setup,
    appId: ctx.app?.id ?? UNREGISTERED_APP_ID,
  });
  const pending = new Set(plan.registrations.map((r) => r.componentKey));
  const newApp = !ctx.app && pending.size > 0;
  const isPending = (issue: SetupIssue) => {
    if (issue.code === "appNotFound") return newApp;
    if (issue.code !== "componentNotFound") return false;
    const index = Number(/^targets\.(\d+)\./.exec(issue.field)?.[1]);
    const key = plan.setup.targets[index]?.componentKey;
    return key !== undefined && pending.has(key);
  };
  return { ...preview, issues: preview.issues.filter((i) => !isPending(i)) };
}

export async function previewNewEnvironment(
  raw: unknown
): Promise<{ plan: NewEnvironmentPlan; preview: SetupPreview | null }> {
  const input = parseInput(raw);
  const caller = await authorize(input);
  const ctx = await loadContext(input, caller);
  const plan = resolveNewEnvironment(input, ctx);
  if (plan.issues.length > 0) return { plan, preview: null };
  return { plan, preview: await previewPlan(plan, ctx) };
}

/** The refusal of an issue found before anything is written. */
function issueRefusal(issue: SetupIssue): CodedHTTPException {
  const taken = TAKEN_CODES[issue.code];
  return taken
    ? new CodedHTTPException(409, taken, `${issue.field} is already taken`)
    : new CodedHTTPException(
        400,
        issue.code,
        `The setup is refused at ${issue.field} (${issue.code})`
      );
}

/** The registration rows of the plan's new repos. */
async function registrationComponents(
  plan: NewEnvironmentPlan
): Promise<RegisterComponentInput[]> {
  const reposByConnection = new Map<string, CiRepo[]>();
  const components: RegisterComponentInput[] = [];
  for (const r of plan.registrations) {
    let repos = reposByConnection.get(r.ciConnectionId);
    if (!repos) {
      const provider = await getProviderForConnection(r.ciConnectionId);
      repos = await ciStep(() => provider.listRepos());
      reposByConnection.set(r.ciConnectionId, repos);
    }
    const repo =
      repos.find((x) => x.fullName === r.repoFullName) ??
      repoNotFound(r.repoFullName);
    components.push({
      componentKey: r.componentKey,
      ciConnectionId: r.ciConnectionId,
      forgeRemoteId: repo.forgeRemoteId,
      bundleImage: bundleImageFor(r.componentKey),
      pipelineMode: r.pipelineMode,
      ...(r.buildSpec ? { buildSpec: r.buildSpec } : {}),
    });
  }
  return components;
}

/** The branches the plan's targets deploy from, by component. */
function environmentBranches(plan: NewEnvironmentPlan): EnvironmentBranches {
  const branches: Record<string, string[]> = {};
  for (const { componentKey, sourceBranch } of plan.setup.targets) {
    const list = branches[componentKey] ?? [];
    if (!list.includes(sourceBranch)) list.push(sourceBranch);
    branches[componentKey] = list;
  }
  return branches;
}

/**
 * Registers the plan's new repos; returns the environment's app id and the
 * branches the generated pipeline file was not committed to. A generated
 * component's build spec is the resolver's: detection's suggestion, or an
 * admin's advanced.pipelines choice (authorize gates it), never other input.
 */
async function registerRepos(
  plan: NewEnvironmentPlan,
  ctx: NewEnvironmentContext
): Promise<{ appId: string; pipelineFileFailures: PipelineFileFailure[] }> {
  if (plan.registrations.length === 0) {
    if (!ctx.app) {
      throw new CodedHTTPException(404, "appNotFound", "App not found");
    }
    return { appId: ctx.app.id, pipelineFileFailures: [] };
  }
  const components = await registrationComponents(plan);
  const branches = environmentBranches(plan);
  if (ctx.app) {
    const { pipelineFileFailures } = await addSetupComponents(
      ctx.app.key,
      components,
      branches
    );
    return { appId: ctx.app.id, pipelineFileFailures };
  }
  const first = plan.registrations[0]?.repoFullName ?? plan.appKey;
  const parsed = registerAppSchema.safeParse({
    appKey: plan.appKey,
    name: (first.split("/").at(-1) || plan.appKey).slice(0, 120),
    components,
  });
  if (!parsed.success) badRequest("Invalid registration", "invalidInput");
  const { app, pipelineFileFailures } = await registerSetupApp(
    parsed.data,
    branches
  );
  return { appId: app.id, pipelineFileFailures };
}

/**
 * Makes the chosen server the project's default when it has none yet, and
 * only an open server unless the caller manages servers. The conditional
 * update leaves a default set meanwhile alone.
 */
async function saveDefaultServer(
  ctx: NewEnvironmentContext,
  serverId: string,
  caller: Caller
): Promise<void> {
  if (ctx.project.defaultServerId !== null) return;
  const server = ctx.servers.find((s) => s.id === serverId);
  if (!server) return;
  if (
    server.placement !== "open" &&
    !canOrg(caller.orgRole, { server: ["manage"] })
  ) {
    return;
  }
  try {
    await db
      .update(projects)
      .set({ defaultServerId: serverId })
      .where(
        and(eq(projects.id, ctx.project.id), isNull(projects.defaultServerId))
      );
  } catch (error) {
    // The environment exists; the default can still be set in Settings.
    console.error("Saving the project default server failed:", error);
  }
}

export type BuildFailure = {
  componentKey: string;
  branch: string;
  code: string | null;
  error: string;
};

export type NewEnvironmentCreated = SetupCreated & {
  /** First builds that did not start; the environment exists regardless. */
  buildFailures: BuildFailure[];
  /** Branches the generated pipeline file was not committed to. */
  pipelineFileFailures: PipelineFileFailure[];
};

/**
 * Starts one build per component and branch, as the New app stepper did.
 * The targets are not flagged here: the provisioning run's deploy step flags
 * each one (`deploy_next_build`) after the database and domain steps, then
 * deploys the newest build or the one that lands next.
 */
async function startFirstBuilds(
  plan: NewEnvironmentPlan,
  appKey: string
): Promise<BuildFailure[]> {
  const failures: BuildFailure[] = [];
  const started = new Set<string>();
  for (const { componentKey, sourceBranch: branch } of plan.setup.targets) {
    const key = `${componentKey}\n${branch}`;
    if (started.has(key)) continue;
    started.add(key);
    try {
      await triggerComponentBuild(appKey, componentKey, branch);
    } catch (error) {
      if (!(error instanceof HTTPException)) {
        console.error(`First build of ${componentKey} ${branch}:`, error);
      }
      failures.push({
        componentKey,
        branch,
        code: errorCode(error) ?? null,
        error:
          error instanceof HTTPException
            ? error.message
            : "The build could not be started",
      });
    }
  }
  return failures;
}

export async function createNewEnvironment(
  raw: unknown
): Promise<NewEnvironmentCreated> {
  const input = parseInput(raw);
  const caller = await authorize(input);
  const ctx = await loadContext(input, caller);
  const plan = resolveNewEnvironment(input, ctx);
  const [planIssue] = plan.issues;
  if (planIssue) throw issueRefusal(planIssue);
  // Every check of the setup before a repo is registered or a branch added.
  const [setupIssue] = (await previewPlan(plan, ctx)).issues;
  if (setupIssue) throw issueRefusal(setupIssue);

  const { appId, pipelineFileFailures } = await registerRepos(plan, ctx);
  const registered = new Set(plan.registrations.map((r) => r.componentKey));
  for (const target of plan.setup.targets) {
    if (registered.has(target.componentKey)) continue;
    const ensured = await ensureComponentBranch(
      target.componentKey,
      target.sourceBranch,
      input.projectId
    );
    pipelineFileFailures.push(...ensured.pipelineFileFailures);
  }

  let created: SetupCreated;
  try {
    created = await createEnvironmentSetup({ ...plan.setup, appId });
  } catch (error) {
    const taken = TAKEN_CODES[errorCode(error) ?? ""];
    if (taken && error instanceof HTTPException) {
      throw new CodedHTTPException(409, taken, error.message);
    }
    throw error;
  }

  await saveDefaultServer(ctx, plan.setup.server.serverId, caller);
  const buildFailures = await startFirstBuilds(plan, plan.appKey);
  return { ...created, buildFailures, pipelineFileFailures };
}

export type SetupRepo = {
  ciConnectionId: string;
  repoFullName: string;
  /** The app whose component builds the repo; null when it is free. */
  appKey: string | null;
  appName: string | null;
  componentKey: string | null;
  /** The repository's main branch on the forge, else `main`. */
  defaultBranch: string;
};

/**
 * The CI server's repos whose name contains `q` (case-insensitive), on the
 * connections whose files the Panel can read, each with the app that already
 * builds it. At most REPO_SEARCH_LIMIT, by name. Same gate as detection.
 */
export async function searchSetupRepos(q: string): Promise<SetupRepo[]> {
  await requireRegistrant();
  const [connections, registry] = await Promise.all([
    listConnectionOptions(),
    listApps(),
  ]);
  const components = registryComponents(registry);
  const needle = q.trim().toLowerCase();
  const rows: SetupRepo[] = [];
  for (const connection of connections) {
    if (connection.forge !== "bitbucket" || !connection.hasForgeToken) continue;
    const provider = await getProviderForConnection(connection.id);
    for (const repo of await ciStep(() => provider.listRepos())) {
      if (!repo.fullName.toLowerCase().includes(needle)) continue;
      const component = componentOfRepo(components, connection.id, repo);
      rows.push({
        ciConnectionId: connection.id,
        repoFullName: repo.fullName,
        appKey: component?.app.appKey ?? null,
        appName: component?.app.name ?? null,
        componentKey: component?.componentKey ?? null,
        defaultBranch: branchSchema.safeParse(repo.defaultBranch).success
          ? (repo.defaultBranch as string)
          : "main",
      });
    }
  }
  return rows
    .sort((a, b) => a.repoFullName.localeCompare(b.repoFullName))
    .slice(0, REPO_SEARCH_LIMIT);
}
