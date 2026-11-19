import { and, asc, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  orgGrantAllows,
  orgGrantRole,
  requireProjectPermission,
} from "@/lib/authz";
import {
  bundleImageFor,
  type RegisterComponentInput,
  registerServicesSchema,
  repoRepresentative,
} from "@/lib/ci/registration";
import { CiProviderError, type CiRepo } from "@/lib/ci/types";
import { db } from "@/lib/db";
import {
  databaseHosts,
  environmentServices,
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
import { listServices, type Service } from "@/lib/service-catalog";
import { repoKeyOf } from "@/lib/setup/draft";
import {
  type NewEnvironmentContext,
  type NewEnvironmentInput,
  type NewEnvironmentPlan,
  newEnvironmentInputSchema,
  resolveNewEnvironment,
} from "@/lib/setup/new-environment";
import type { SetupIssue } from "@/lib/setup/schema";
import { listServiceTemplates } from "@/lib/variables/repository";
import {
  badRequest,
  CodedHTTPException,
  errorCode,
  notFound,
} from "@/server/errors";
import {
  type EnvironmentBranches,
  ensureComponentBranch,
  type PipelineFileFailure,
  registerSetupServices,
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
 * repos the plan lists as new services (no app), adds the environment's
 * branch to generated services, runs the setup,
 * makes the first server choice the project default and starts the first
 * builds, which deploy when they land (`deploy_next_build`).
 *
 * Who: the setup's callers (environment:create plus the deploy and variable
 * rights it asks for); a QA gets 403 before anything is read.
 */

/**
 * The Access policy a new address is behind unless the copy source has one:
 * the instance names it in ACCESS_DEFAULT_POLICY_NAME (matched
 * case-insensitively); unset means no preselection.
 */
function defaultAccessPolicyName(): string | null {
  return process.env.ACCESS_DEFAULT_POLICY_NAME?.trim().toLowerCase() || null;
}
const REPO_SEARCH_LIMIT = 50;

// The unique-index races of a create (and the same checks seen just before
// it), under the codes the New environment page knows. A slug the name gave
// is the name's refusal; a slug the caller chose keeps its own code.
const TAKEN_CODES: Record<string, "nameTaken" | "domainTaken"> = {
  environmentNameTaken: "nameTaken",
  environmentSlugTaken: "nameTaken",
  environmentSlugAliasTaken: "nameTaken",
  domainHostnameTaken: "domainTaken",
};
const SLUG_CODES = new Set([
  "environmentSlugTaken",
  "environmentSlugAliasTaken",
]);

/** The code a taken name, slug or hostname is refused with on this page. */
function takenCode(
  code: string,
  input: NewEnvironmentInput
): string | undefined {
  if (input.slug !== undefined && SLUG_CODES.has(code)) return code;
  return TAKEN_CODES[code];
}

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

/**
 * The service a CI repository builds, if any; for a repository building
 * several, its non-artifact one (see repoRepresentative).
 */
function componentOfRepo(
  components: Service[],
  ciConnectionId: string,
  repo: { fullName: string; ciRepoId?: string }
): Service | undefined {
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
 * named by defaultAccessPolicyName(); null when neither is there or the
 * Cloudflare account cannot be read (the resolver then asks for one).
 */
async function defaultAccessPolicy(
  projectId: string,
  sourcePolicyId: string | null
): Promise<string | null> {
  try {
    const policies = await listProjectAccessPolicies(projectId);
    const defaultName = defaultAccessPolicyName();
    return (
      policies.find((p) => p.id === sourcePolicyId)?.id ??
      (defaultName
        ? policies.find((p) => p.name.toLowerCase() === defaultName)?.id
        : undefined) ??
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

/**
 * The detection of a registered service's repository on `branch`, or null
 * when it cannot be read (it only fills names).
 */
async function detectQuietly(service: Service, branch: string) {
  try {
    return await detect(service.ciConnectionId, service.repoFullName, branch);
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    return null;
  }
}

/** Everything the resolver needs, read for this caller. */
async function loadContext(
  input: NewEnvironmentInput,
  caller: Caller
): Promise<NewEnvironmentContext> {
  const [[project], serverRows, hostRows, components, zones, slug] =
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
      listServices(),
      listZones(),
      input.slug ?? uniqueEnvSlug(input.projectId, input.name),
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

  // The copy source, by the copy rules (getCopySource filters the variables).
  const source = input.copyFromEnvironmentId
    ? await getCopySource(input.copyFromEnvironmentId)
    : null;

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
        component: component ? { componentKey: component.key } : null,
      };
    })
  );
  // The picked services, detected on their branch where their repository
  // can be read (detection only fills names).
  const services: NewEnvironmentContext["services"] = [];
  for (const picked of input.services) {
    const service = components.find((c) => c.key === picked.componentKey);
    if (!service || services.some((s) => s.componentKey === service.key)) {
      continue;
    }
    services.push({
      componentKey: service.key,
      detection: await detectQuietly(service, picked.branch),
    });
  }
  // A copy without picked repos: the source's components, detected where
  // their repos can be read (detection only fills names).
  if (input.repos.length === 0 && input.services.length === 0 && source) {
    for (const target of source.targets) {
      const component = components.find((c) => c.key === target.componentKey);
      if (!component) continue;
      const detection = await detectQuietly(component, target.sourceBranch);
      if (!detection) continue;
      repos.push({
        repoFullName: component.repoFullName,
        ciConnectionId: component.ciConnectionId,
        detection,
        component: { componentKey: component.key },
      });
    }
  }
  // The names the picked registered services' templates define: a copy
  // keeps those source variables (keepsCopiedVariable).
  const pickedKeys = [
    ...services.map((s) => s.componentKey),
    ...repos.flatMap((r) => (r.component ? [r.component.componentKey] : [])),
  ];
  const templateNames = [
    ...new Set(
      (await listServiceTemplates([...new Set(pickedKeys)])).map((t) => t.name)
    ),
  ];

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
    services,
    templateNames,
    repoOf: Object.fromEntries(
      components
        .filter(
          (c) =>
            input.services.some((p) => p.componentKey === c.key) ||
            source?.targets.some((t) => t.componentKey === c.key)
        )
        .map((c) => [c.key, repoKeyOf(c.ciConnectionId, c.repoFullName)])
    ),
    slug,
    copySource: source,
    suggestedPort,
    defaultZoneId: source?.domain.zoneId ?? zones[0]?.id ?? null,
    defaultAccessPolicyId,
    zones,
    existingDbNames,
    takenComponentKeys: components.map((c) => c.key),
  };
}

/**
 * The setup preview of a resolved plan. Before the create registers them, the
 * new services do not exist: their refusal is dropped.
 */
async function previewPlan(plan: NewEnvironmentPlan): Promise<SetupPreview> {
  const preview = await previewEnvironmentSetup(plan.setup);
  const pending = new Set(plan.registrations.map((r) => r.componentKey));
  const isPending = (issue: SetupIssue) => {
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
  return { plan, preview: await previewPlan(plan) };
}

/** The refusal of an issue found before anything is written. */
function issueRefusal(
  issue: SetupIssue,
  input: NewEnvironmentInput
): CodedHTTPException {
  const taken = takenCode(issue.code, input);
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
 * Registers the plan's new repos as services (no app); returns the branches
 * the generated pipeline file was not committed to. A generated service's
 * build spec is the resolver's: detection's suggestion, or an admin's
 * advanced.pipelines choice (authorize gates it), never other input.
 */
async function registerRepos(
  plan: NewEnvironmentPlan
): Promise<PipelineFileFailure[]> {
  if (plan.registrations.length === 0) return [];
  const parsed = registerServicesSchema.safeParse({
    services: await registrationComponents(plan),
  });
  if (!parsed.success) badRequest("Invalid registration", "invalidInput");
  return registerSetupServices(parsed.data.services, environmentBranches(plan));
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
  plan: NewEnvironmentPlan
): Promise<BuildFailure[]> {
  const failures: BuildFailure[] = [];
  const started = new Set<string>();
  for (const { componentKey, sourceBranch: branch } of plan.setup.targets) {
    const key = `${componentKey}\n${branch}`;
    if (started.has(key)) continue;
    started.add(key);
    try {
      await triggerComponentBuild(componentKey, branch);
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
  if (planIssue) throw issueRefusal(planIssue, input);
  // Every check of the setup before a repo is registered or a branch added.
  const [setupIssue] = (await previewPlan(plan)).issues;
  if (setupIssue) throw issueRefusal(setupIssue, input);

  const pipelineFileFailures = await registerRepos(plan);
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
    created = await createEnvironmentSetup(plan.setup);
  } catch (error) {
    const taken = takenCode(errorCode(error) ?? "", input);
    if (taken && error instanceof HTTPException) {
      throw new CodedHTTPException(409, taken, error.message);
    }
    throw error;
  }

  await saveDefaultServer(ctx, plan.setup.server.serverId, caller);
  const buildFailures = await startFirstBuilds(plan);
  return { ...created, buildFailures, pipelineFileFailures };
}

export type SetupRepo = {
  ciConnectionId: string;
  repoFullName: string;
  /** The service the repo builds (its non-artifact one); null when free. */
  componentKey: string | null;
  /** The repository's main branch on the forge, else `main`. */
  defaultBranch: string;
};

/**
 * The CI server's repos whose name contains `q` (case-insensitive), on the
 * connections whose files the Panel can read, each with the service that
 * already builds it. At most REPO_SEARCH_LIMIT, by name. Same gate as
 * detection.
 */
export async function searchSetupRepos(q: string): Promise<SetupRepo[]> {
  await requireRegistrant();
  const [connections, components] = await Promise.all([
    listConnectionOptions(),
    listServices(),
  ]);
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
        componentKey: component?.key ?? null,
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
