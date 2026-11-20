import { stripVTControlCharacters } from "node:util";
import { type FlexibleSchema, jsonSchema } from "ai";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type OrgScope, requireOrgPermissionIn } from "@/lib/access-scope";
import { db } from "@/lib/db";
import type { EnvironmentListItem } from "@/lib/db/schema";
import { resolveEnvironmentBySlug } from "@/lib/environment-slug";
import { listPeopleFor } from "@/lib/people/queries";
import type { OrgPermissions } from "@/lib/permissions";
import { callName } from "@/lib/user-display";
import { listActivityFor } from "@/server/services/activity";
import { listProjectBuildsFor } from "@/server/services/deploy-builds";
import { getDeployLockStateFor } from "@/server/services/deploy-locks";
import {
  getDeploymentFor,
  listDeployTargetsFor,
} from "@/server/services/deploys";
import {
  getEnvironmentRunningFor,
  listEnvironmentsFor,
} from "@/server/services/environments";
import { getIssueDetailFor, listAllIssuesFor } from "@/server/services/issues";
import {
  getEnvironmentKpisFor,
  getRunSnapshotFor,
  type KpiEntry,
} from "@/server/services/runs";
import { getServerFor, getServersFor } from "@/server/services/servers";
import {
  getAllServiceStatusesFor,
  getServiceLogsFor,
} from "@/server/services/services";
import { redactPii } from "../pii-filter";
import { REDACTED_LINE, redactSecretLines } from "../secret-filter";
import type { AssistantViewer, ProjectEntry } from "../viewer";
import type { ToolMeta, ToolResult } from "./code";
import {
  clamp,
  compact,
  type DataContext,
  environmentByRef,
  envRef,
  fail,
  iso,
  mapLimit,
  ok,
  projectByKey,
  safeText,
  unknownEnvironment,
  unknownProjectError,
  withWithheld,
} from "./data-shared";

/**
 * Data tools: read-only views of Menara data (environments, live status,
 * deploys, builds, Menara issues, people, servers, activity). Each one calls
 * the page's own service core (the xxxFor functions) with the viewer's
 * AccessScope, so the assistant sees exactly what the pages show that user.
 * Results are compact: nulls dropped, lists capped, free text redacted with
 * the secret filter.
 */

/** Live status probes (SSH) per turn; more environments are "not checked". */
export const STATUS_PROBES_PER_TURN = 10;
/** A probe that has not answered by then reports every service unknown. */
export const STATUS_PROBE_TIMEOUT_MS = 30_000;
/** Most deploys, builds and issue hits one call returns. */
export const DATA_LIST_LIMIT = 20;
export const DEFAULT_LIST_LIMIT = 10;
export const MAX_ENVIRONMENTS = 100;
/** Environments whose deploy state list_environments reads at once. */
const ENVIRONMENT_STATE_CONCURRENCY = 5;
export const MAX_PEOPLE = 200;
export const MAX_SERVERS = 100;
export const ACTIVITY_LIMIT = 50;
export const DEFAULT_ACTIVITY_LIMIT = 20;
export const DEPLOY_LOG_LINES = 200;
export const MAX_DEPLOY_LOG_BYTES = 32 * 1024;
export const SERVICE_LOG_LINES = 200;
export const DEFAULT_SERVICE_LOG_LINES = 100;
export const MAX_SERVICE_LOG_BYTES = 32 * 1024;
/** The longest `since` the tool takes (7 days). */
export const MAX_LOG_SINCE_SECONDS = 7 * 24 * 3600;
export const MAX_ISSUE_DESCRIPTION_BYTES = 16 * 1024;
export const MAX_ISSUE_COMMENTS = 50;
export const MAX_ISSUE_COMMENT_BYTES = 4 * 1024;

/** The service cores the tools read through (tests replace them). */
export type DataCores = {
  listEnvironments: typeof listEnvironmentsFor;
  getEnvironmentRunning: typeof getEnvironmentRunningFor;
  getServiceStatuses: typeof getAllServiceStatusesFor;
  getDeployLockState: typeof getDeployLockStateFor;
  getServiceLogs: typeof getServiceLogsFor;
  getEnvironmentKpis: typeof getEnvironmentKpisFor;
  listDeployTargets: typeof listDeployTargetsFor;
  getDeployment: typeof getDeploymentFor;
  getRunSnapshot: typeof getRunSnapshotFor;
  listProjectBuilds: typeof listProjectBuildsFor;
  listIssues: typeof listAllIssuesFor;
  getIssueDetail: typeof getIssueDetailFor;
  listPeople: typeof listPeopleFor;
  getServers: typeof getServersFor;
  getServer: typeof getServerFor;
  listActivity: typeof listActivityFor;
  /** The environment an old (renamed) slug still names, if any. */
  resolveEnvironmentSlug: typeof resolveEnvironmentBySlug;
  /** Display names of environment owners, by user id. */
  ownerNames: (ids: string[]) => Promise<Map<string, string>>;
};

async function ownerNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.query.users.findMany({
    where: { id: { in: ids } },
    columns: { id: true, name: true, preferredName: true },
  });
  return new Map(rows.map((u) => [u.id, callName(u)]));
}

export const DATA_CORES: DataCores = {
  listEnvironments: listEnvironmentsFor,
  getEnvironmentRunning: getEnvironmentRunningFor,
  getServiceStatuses: getAllServiceStatusesFor,
  getDeployLockState: getDeployLockStateFor,
  getServiceLogs: getServiceLogsFor,
  getEnvironmentKpis: getEnvironmentKpisFor,
  listDeployTargets: listDeployTargetsFor,
  getDeployment: getDeploymentFor,
  getRunSnapshot: getRunSnapshotFor,
  listProjectBuilds: listProjectBuildsFor,
  listIssues: listAllIssuesFor,
  getIssueDetail: getIssueDetailFor,
  listPeople: listPeopleFor,
  getServers: getServersFor,
  getServer: getServerFor,
  listActivity: listActivityFor,
  resolveEnvironmentSlug: resolveEnvironmentBySlug,
  ownerNames,
};

type ServiceStatus = { role: string; state: string; error?: string };

export type EnvironmentStatus = {
  environment: string;
  name: string;
  /** False when the live probe was not run (STATUS_PROBES_PER_TURN). */
  checked: boolean;
  reason?: "limit";
  services?: ServiceStatus[];
  running?: Record<string, unknown>[];
  lock?: Record<string, unknown>;
  heldDeploys?: number;
  lastBackup?: { at: string | null; status: string };
  lastRestore?: { at: string | null; status: string };
  lastMockTime?: { at: string | null; status: string };
};

/**
 * The data state of one turn: the viewer's projects and environments
 * (loaded once) and the live status probes (memoised per environment, at
 * most STATUS_PROBES_PER_TURN distinct environments).
 */
export type DataTurn = {
  cores: DataCores;
  projects: () => Promise<ProjectEntry[]>;
  environments: () => Promise<EnvironmentListItem[]>;
  probe: (environment: EnvironmentListItem) => Promise<ServiceStatus[] | null>;
};

export type DataTurnOptions = {
  /** The viewer's visible projects. */
  projects: () => Promise<ProjectEntry[]>;
  cores?: Partial<DataCores>;
  probeTimeoutMs?: number;
};

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= load().catch((error) => {
      value = undefined;
      throw error;
    });
    return value;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`status probe timed out after ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createDataTurn(
  viewer: AssistantViewer,
  options: DataTurnOptions
): DataTurn {
  const cores = { ...DATA_CORES, ...options.cores };
  const timeoutMs = options.probeTimeoutMs ?? STATUS_PROBE_TIMEOUT_MS;
  const probes = new Map<string, Promise<ServiceStatus[]>>();
  const unknown = (env: EnvironmentListItem): ServiceStatus[] =>
    env.serviceRoles.map((role) => ({ role, state: "unknown" }));

  return {
    cores,
    projects: once(options.projects),
    environments: once(() => cores.listEnvironments(viewer.scope)),
    probe: (env) => {
      const known = probes.get(env.id);
      if (known) return known;
      if (probes.size >= STATUS_PROBES_PER_TURN) return Promise.resolve(null);
      const run = withTimeout(
        cores.getServiceStatuses(viewer.scope, env.id),
        timeoutMs
      ).then(
        (results) =>
          results.map((r) => ({
            role: r.role,
            state: r.state,
            ...(r.error ? { error: safeText(r.error).text ?? "" } : {}),
          })),
        (error) => {
          // A refusal is not a probe failure: the caller reports it.
          if (error instanceof HTTPException) throw error;
          console.error("[assistant] status probe failed", error);
          return unknown(env);
        }
      );
      probes.set(env.id, run);
      return run;
    },
  };
}

// --- definitions ------------------------------------------------------------

const str = (description: string) => z.string().describe(description);
const nullable = <T extends z.ZodType>(type: T, description: string) =>
  type.nullable().describe(description);
const empty = z.strictObject({});

const SERVICE_ROLES = ["db", "backend", "frontend"] as const;

const environmentArg = str(
  'Environment as "PROJECTKEY/slug" (from list_environments, e.g. "ACME/uat") or its id.'
);

/** Tools every viewer gets, in order. */
const ALWAYS = {
  list_environments: {
    description: `List the Menara environments the user can see (at most ${MAX_ENVIRONMENTS}): reference ("PROJECTKEY/slug"), name, kind, URL, owner. With a project, each environment also has its last deploy (status, time, tag) and whether deploys are locked; without one these are left out, so pass a project or use get_environment_status. Database data only; use get_environment_status for live service state and running versions.`,
    inputSchema: z.strictObject({
      project: nullable(
        z.string(),
        'Only this project key (e.g. "ACME"); null for every project.'
      ),
    }),
  },
  get_environment_status: {
    description: `Live state of one environment, as its dashboard shows it: each service running/stopped/not-found/unknown (live check), the version each component runs, an active deploy lock, and the last backup, restore and mock-time runs. At most ${STATUS_PROBES_PER_TURN} environments are checked live per answer; beyond that "checked" is false (reason "limit"). "unknown" means the check failed; an empty services list means no services are registered for the environment in Menara, so nothing could be checked live.`,
    inputSchema: z.strictObject({ environment: environmentArg }),
  },
  get_service_logs: {
    description: `The last lines of one running service's logs (docker, kubectl or journalctl, as the Logs page shows them; at most ${SERVICE_LOG_LINES} lines, ${MAX_SERVICE_LOG_BYTES / 1024} KiB), optionally only the recent ones. Needs the Logs page's permission on that environment; a shared database container's logs are limited as on the Logs page. Lines holding credentials are redacted, and personal identifiers (emails, NIK, NPWP, phone and card numbers) are replaced by [redacted …] markers. Use it to see why a service fails at runtime; the deploy's own log is get_deploy.`,
    inputSchema: z.strictObject({
      environment: environmentArg,
      role: z
        .enum(SERVICE_ROLES)
        .describe("Which service: db, backend or frontend."),
      lines: nullable(
        z.number(),
        `How many lines (whole number, at most ${SERVICE_LOG_LINES}). Default ${DEFAULT_SERVICE_LOG_LINES}.`
      ),
      since: nullable(
        z.string(),
        'Only entries from the last duration, e.g. "30m", "2h" or "1d" (s, m, h or d; at most 7d); null for no limit.'
      ),
    }),
  },
  list_deploys: {
    description: `Deploy history of one environment, newest first, up to ${DATA_LIST_LIMIT} (as many as the Deploys page keeps): component, tag, status, trigger, who, when, duration, branch and commit; plus each component's current and previous tag.`,
    inputSchema: z.strictObject({
      environment: environmentArg,
      limit: nullable(
        z.number(),
        `How many deploys (whole number, at most ${DATA_LIST_LIMIT}). Default ${DEFAULT_LIST_LIMIT}.`
      ),
    }),
  },
  get_deploy: {
    description: `One deploy by id (from list_deploys) with the tail of its log (last ${DEPLOY_LOG_LINES} lines; lines holding credentials are redacted). Use it to explain a failed deploy.`,
    inputSchema: z.strictObject({ id: str("Deploy id from list_deploys.") }),
  },
  list_builds: {
    description: `Recent CI builds of a project's deployed components and branches, newest first (at most ${DATA_LIST_LIMIT}): component, branch, tag, commit, who pushed, commit message.`,
    inputSchema: z.strictObject({
      project: str('Project key, e.g. "ACME".'),
      limit: nullable(
        z.number(),
        `How many builds (whole number, at most ${DATA_LIST_LIMIT}). Default ${DEFAULT_LIST_LIMIT}.`
      ),
    }),
  },
  search_panel_issues: {
    description: `Search the Menara issues (any status) by text over title, description and key (e.g. "ACME-12"). At most ${DATA_LIST_LIMIT} hits, most recently updated first.`,
    inputSchema: z.strictObject({
      query: str("Search text."),
      project: nullable(z.string(), "Only this project key; null for all."),
    }),
  },
  get_panel_issue: {
    description: `One Menara issue by key ("ACME-12"): status, type, priority, assignee, labels, parent and children, description and the latest ${MAX_ISSUE_COMMENTS} comments. For Jira issues use get_issue.`,
    inputSchema: z.strictObject({
      key: str('Menara issue key, e.g. "ACME-12".'),
    }),
  },
  list_people: {
    description: `People in Menara as the People page shows them (at most ${MAX_PEOPLE}): name, what they like to be called, email, title, job role and the projects they can see.`,
    inputSchema: z.strictObject({
      project: nullable(
        z.string(),
        "Only people who can see this project key; null for everyone."
      ),
    }),
  },
} as const;

/** Tools behind an org permission, as the matching page. */
const GATED = {
  list_servers: {
    description: `List the servers Menara manages (at most ${MAX_SERVERS}): name, host, placement. No credentials.`,
    // Written out: zod emits no `required` for an empty object, and strict
    // tools expect the (empty) list.
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    }),
    perms: { server: ["read"] },
  },
  get_server: {
    description:
      "One server by name or id: host, user, sign-in kind, placement, and its last preflight scan (runtimes, disk). No credentials.",
    inputSchema: z.strictObject({ server: str("Server name or id.") }),
    perms: { server: ["read"] },
  },
  recent_activity: {
    description: `The Menara activity log, newest first (at most ${ACTIVITY_LIMIT}): action, who, when and its details.`,
    inputSchema: z.strictObject({
      limit: nullable(
        z.number(),
        `How many entries (whole number, at most ${ACTIVITY_LIMIT}). Default ${DEFAULT_ACTIVITY_LIMIT}.`
      ),
    }),
    perms: { audit: ["read"] },
  },
} as const satisfies Record<
  string,
  {
    description: string;
    inputSchema: FlexibleSchema<unknown>;
    perms: OrgPermissions;
  }
>;

type DataDefinition = {
  description: string;
  inputSchema: FlexibleSchema<unknown>;
};

export type DataToolName = keyof typeof ALWAYS | keyof typeof GATED;

export const DATA_TOOL_NAMES = [
  ...Object.keys(ALWAYS),
  ...Object.keys(GATED),
] as DataToolName[];

export function isDataTool(name: string): name is DataToolName {
  return Object.hasOwn(ALWAYS, name) || Object.hasOwn(GATED, name);
}

/** The org decision the page makes (requireOrgPermissionIn), as a boolean. */
function orgAllows(scope: OrgScope, perms: OrgPermissions): boolean {
  try {
    requireOrgPermissionIn(scope, perms);
    return true;
  } catch (error) {
    if (error instanceof HTTPException) return false;
    throw error;
  }
}

/** The data tools offered to this viewer, with what the model sees. */
export function dataDefinitions(
  viewer: AssistantViewer
): Array<[DataToolName, DataDefinition]> {
  const gated = Object.entries(GATED)
    .filter(([, d]) => orgAllows(viewer.scope, d.perms))
    .map(([name, d]): [DataToolName, DataDefinition] => [
      name as DataToolName,
      { description: d.description, inputSchema: d.inputSchema },
    ]);
  return [
    ...(Object.entries(ALWAYS) as Array<[DataToolName, DataDefinition]>),
    ...gated,
  ];
}

export function dataToolOffered(
  viewer: AssistantViewer,
  name: DataToolName
): boolean {
  if (Object.hasOwn(ALWAYS, name)) return true;
  const gated = GATED[name as keyof typeof GATED];
  return gated !== undefined && orgAllows(viewer.scope, gated.perms);
}

const limit = z.number().nullish();

/** Validation, independent of the schemas the model sees. */
export const DATA_INPUTS = {
  list_environments: z.strictObject({ project: z.string().nullish() }),
  get_environment_status: z.strictObject({ environment: z.string() }),
  list_deploys: z.strictObject({ environment: z.string(), limit }),
  get_service_logs: z.strictObject({
    environment: z.string(),
    role: z.string(),
    lines: limit,
    since: z.string().nullish(),
  }),
  get_deploy: z.strictObject({ id: z.string() }),
  list_builds: z.strictObject({ project: z.string(), limit }),
  search_panel_issues: z.strictObject({
    query: z.string(),
    project: z.string().nullish(),
  }),
  get_panel_issue: z.strictObject({ key: z.string() }),
  list_people: z.strictObject({ project: z.string().nullish() }),
  list_servers: empty,
  get_server: z.strictObject({ server: z.string() }),
  recent_activity: z.strictObject({ limit }),
} as const satisfies Record<DataToolName, z.ZodType>;

// --- helpers ----------------------------------------------------------------

const short = (sha: string | null | undefined) => sha?.slice(0, 10) ?? null;

const isRefusal = (error: unknown) =>
  error instanceof HTTPException &&
  (error.status === 404 || error.status === 403);

const envMeta = (env: EnvironmentListItem): ToolMeta => ({
  project: env.key,
  environment: envRef(env),
});

// --- tools ------------------------------------------------------------------

async function listEnvironmentsTool(
  ctx: DataContext,
  project: string | null | undefined
) {
  let envs = await ctx.data.environments();
  let meta: ToolMeta = {};
  let oneProject = false;
  if (project) {
    oneProject = true;
    const found = await projectByKey(ctx, project);
    if (typeof found === "string") {
      return fail(unknownProjectError(found, ctx.mode), { project: found });
    }
    envs = envs.filter((e) => e.projectId === found.id);
    meta = { project: found.key };
  }
  const sorted = [...envs].sort(
    (a, b) => a.key.localeCompare(b.key) || a.name.localeCompare(b.name)
  );
  const shown = sorted.slice(0, MAX_ENVIRONMENTS);
  const owners = await ctx.data.cores.ownerNames([
    ...new Set(shown.flatMap((e) => (e.ownerId ? [e.ownerId] : []))),
  ]);
  const projects = (await ctx.data.projects())
    .filter((p) => shown.some((e) => e.projectId === p.id))
    .map((p) => ({ key: p.key, name: p.name }));
  // One project's environments are few: each gets its last deploy and lock
  // from the Deploys page's cores. Across every project that would be a
  // query per environment, so the description points to a project instead.
  const deployState = oneProject
    ? await mapLimit(shown, ENVIRONMENT_STATE_CONCURRENCY, (e) =>
        environmentDeployState(ctx, e)
      )
    : [];
  return ok(
    compact({
      projects,
      environments: shown.map((e, i) =>
        compact({
          ref: envRef(e),
          name: e.name,
          kind: e.kind,
          url: e.url,
          owner: e.ownerId ? (owners.get(e.ownerId) ?? null) : null,
          ...deployState[i],
        })
      ),
      more: sorted.length > shown.length ? sorted.length - shown.length : null,
    }),
    meta
  );
}

/** An environment's newest deploy (any component) and its deploy lock. */
async function environmentDeployState(
  ctx: DataContext,
  env: EnvironmentListItem
): Promise<{
  lastDeploy?: Record<string, unknown>;
  lock?: Record<string, unknown>;
}> {
  const { scope } = ctx.viewer;
  try {
    const [targets, lock] = await Promise.all([
      ctx.data.cores.listDeployTargets(scope, env.id),
      ctx.data.cores.getDeployLockState(scope, env.id),
    ]);
    const last = targets
      .flatMap((t) => t.recentDeployments)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id)
      )[0];
    return {
      ...(last
        ? {
            lastDeploy: compact({
              status: last.status,
              at: iso(last.createdAt),
              tag: last.tag,
            }),
          }
        : {}),
      lock: lock.lock
        ? compact({ locked: true, reason: safeText(lock.lock.reason).text })
        : { locked: false },
    };
  } catch (error) {
    if (isRefusal(error)) return {};
    throw error;
  }
}

async function environmentStatusTool(ctx: DataContext, given: string) {
  const env = await environmentByRef(ctx, given);
  if (!env) return fail(unknownEnvironment(given.trim()));
  const meta = envMeta(env);
  const { scope } = ctx.viewer;
  try {
    const [services, running, lock, kpis] = await Promise.all([
      ctx.data.probe(env),
      ctx.data.cores.getEnvironmentRunning(scope, env.id),
      ctx.data.cores.getDeployLockState(scope, env.id),
      ctx.data.cores.getEnvironmentKpis(scope, env.id),
    ]);
    const lastRun = (entry: KpiEntry) =>
      entry ? { at: iso(entry.runAt), status: entry.status } : undefined;
    const data: EnvironmentStatus = {
      environment: envRef(env),
      name: env.name,
      checked: services !== null,
      ...(services === null ? { reason: "limit" as const } : { services }),
      running: running.items.map((item) =>
        compact({
          component: item.componentKey,
          tag: item.tag,
          commit: short(item.commitSha),
          deployed: item.deployed,
          deployedAt: iso(item.deployedAt),
        })
      ),
      ...(lock.lock
        ? {
            lock: compact({
              by: lock.lock.lockedBy?.name ?? null,
              reason: safeText(lock.lock.reason).text,
              expiresAt: iso(lock.lock.expiresAt),
            }),
          }
        : {}),
      ...(lock.heldCount > 0 ? { heldDeploys: lock.heldCount } : {}),
      lastBackup: lastRun(kpis.lastBackup),
      lastRestore: lastRun(kpis.lastRestore),
      lastMockTime: lastRun(kpis.lastMock),
    };
    // An empty list is an answer (no services registered), not missing data:
    // kept, unlike compact's other empty fields.
    const shown = {
      ...compact(data),
      ...(services ? { services } : {}),
    };
    return ok(shown, { ...meta, checked: data.checked });
  } catch (error) {
    if (isRefusal(error)) return fail(unknownEnvironment(given.trim()));
    throw error;
  }
}

async function listDeploysTool(
  ctx: DataContext,
  given: string,
  rawLimit: number | null | undefined
) {
  const env = await environmentByRef(ctx, given);
  if (!env) return fail(unknownEnvironment(given.trim()));
  const meta = envMeta(env);
  const count = clamp(rawLimit, DEFAULT_LIST_LIMIT, DATA_LIST_LIMIT);
  let targets: Awaited<ReturnType<DataCores["listDeployTargets"]>>;
  try {
    targets = await ctx.data.cores.listDeployTargets(ctx.viewer.scope, env.id);
  } catch (error) {
    if (isRefusal(error)) return fail(unknownEnvironment(given.trim()));
    throw error;
  }
  const deploys = targets
    .flatMap((t) =>
      t.recentDeployments.map((d) => ({ component: t.componentKey, d }))
    )
    .sort(
      (a, b) =>
        b.d.createdAt.getTime() - a.d.createdAt.getTime() ||
        b.d.id.localeCompare(a.d.id)
    )
    .slice(0, count);
  return ok(
    {
      environment: envRef(env),
      components: targets.map((t) =>
        compact({
          component: t.componentKey,
          branch: t.sourceBranch,
          currentTag: t.currentTag,
          currentStatus: t.currentStatus,
          previousTag: t.previousTag,
          autoDeploy: t.autoDeploy || null,
        })
      ),
      deploys: deploys.map(({ component, d }) => deploySummary(component, d)),
    },
    meta
  );
}

type DeployEntry = Awaited<
  ReturnType<DataCores["listDeployTargets"]>
>[number]["recentDeployments"][number];

function deploySummary(component: string, d: DeployEntry) {
  const seconds =
    d.startedAt && d.finishedAt
      ? Math.round((d.finishedAt.getTime() - d.startedAt.getTime()) / 1000)
      : null;
  return compact({
    id: d.id,
    component,
    tag: d.tag,
    status: d.status,
    trigger: d.trigger,
    by: d.userName ?? d.autoUser?.name ?? d.triggeredBy ?? null,
    at: iso(d.createdAt),
    durationSeconds: seconds,
    branch: d.build?.branch ?? null,
    commit: short(d.build?.commitSha),
  });
}

/** The last DEPLOY_LOG_LINES lines, each through the secret filter. */
export function deployLogTail(output: string): {
  log: string;
  truncated: boolean;
  redacted: number;
} {
  // The whole log is filtered before it is cut: a tail starting inside a
  // pasted key would otherwise lose the BEGIN line that marks the block.
  const lines = redactSecretLines(output.replace(/\n$/, "")).text.split("\n");
  const tail = lines.slice(-DEPLOY_LOG_LINES);
  const joined = tail.join("\n");
  // Cut from the start: the end of a log explains how it ended.
  const bytes = Buffer.from(joined, "utf8");
  const tooLong = bytes.byteLength > MAX_DEPLOY_LOG_BYTES;
  const log = tooLong
    ? new TextDecoder()
        .decode(bytes.subarray(bytes.byteLength - MAX_DEPLOY_LOG_BYTES))
        .replace(/^\uFFFD+/, "")
    : joined;
  return {
    log,
    truncated: lines.length > tail.length || tooLong,
    redacted: tail.filter((line) => line === REDACTED_LINE).length,
  };
}

/** "30m", "2h", "1d", "90s" as seconds; null when it is none of those. */
export function parseLogSince(raw: string): number | null {
  const match = /^(\d{1,5})\s*([smhd])$/i.exec(raw.trim());
  if (!match) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[
    (match[2] as string).toLowerCase() as "s" | "m" | "h" | "d"
  ];
  const seconds = Number(match[1]) * unit;
  return seconds >= 1 && seconds <= MAX_LOG_SINCE_SECONDS ? seconds : null;
}

/**
 * The last `lines` lines of a service log: no ANSI, secrets redacted, then
 * personal identifiers (emails, NIK, NPWP, phone and card numbers), then
 * byte-capped. `redacted` counts both.
 */
export function serviceLogTail(
  output: string,
  lines: number
): { log: string; truncated: boolean; redacted: number } {
  // The whole output is filtered before it is cut (a tail starting inside a
  // pasted key would lose the BEGIN line that marks the block).
  const clean = stripVTControlCharacters(output).replace(/\r/g, "");
  const filtered = redactSecretLines(clean.replace(/\n+$/, ""));
  const all = filtered.text.split("\n");
  const tail = all.slice(-lines);
  // Before the byte cut, so it never splits a value it would have caught.
  const pii = redactPii(tail.join("\n"));
  const joined = pii.text;
  const bytes = Buffer.from(joined, "utf8");
  const tooLong = bytes.byteLength > MAX_SERVICE_LOG_BYTES;
  const log = tooLong
    ? new TextDecoder()
        .decode(bytes.subarray(bytes.byteLength - MAX_SERVICE_LOG_BYTES))
        .replace(/^\uFFFD+/, "")
    : joined;
  return {
    log,
    truncated: all.length > tail.length || tooLong,
    redacted:
      tail.filter((line) => line === REDACTED_LINE).length + pii.redacted,
  };
}

async function getServiceLogsTool(
  ctx: DataContext,
  input: z.infer<typeof DATA_INPUTS.get_service_logs>
) {
  const env = await environmentByRef(ctx, input.environment);
  if (!env) return fail(unknownEnvironment(input.environment.trim()));
  const meta = envMeta(env);
  const role = SERVICE_ROLES.find((r) => r === input.role.trim().toLowerCase());
  if (!role) {
    return fail(
      `Unknown service ${input.role}. Use db, backend or frontend.`,
      meta
    );
  }
  if (!env.serviceRoles.includes(role)) {
    return fail(`${envRef(env)} has no ${role} service.`, meta);
  }
  let sinceSeconds: number | undefined;
  if (input.since?.trim()) {
    const parsed = parseLogSince(input.since);
    if (parsed === null) {
      return fail(
        'Invalid "since": use a number and s, m, h or d, e.g. "30m", at most 7d.',
        meta
      );
    }
    sinceSeconds = parsed;
  }
  const lines = clamp(
    input.lines,
    DEFAULT_SERVICE_LOG_LINES,
    SERVICE_LOG_LINES
  );
  let result: Awaited<ReturnType<DataCores["getServiceLogs"]>>;
  try {
    result = await ctx.data.cores.getServiceLogs(
      ctx.viewer.scope,
      env.id,
      role,
      { lines, sinceSeconds }
    );
  } catch (error) {
    if (isRefusal(error)) {
      const why =
        role === "db"
          ? "the Logs page is not open to this user for it, or it is a shared database container (its logs show other environments and are not available through the Assistant)"
          : "the Logs page is not open to this user for it";
      return fail(
        `You can't read the ${role} logs of ${envRef(env)}: ${why}. Say so; do not guess the logs.`,
        meta
      );
    }
    // The SSH error may echo the command or host details: not for the model.
    console.error("[assistant] service logs failed", error);
    return fail(
      `The ${role} logs of ${envRef(env)} could not be read from its server.`,
      meta
    );
  }
  if (!result.found) {
    return fail(`${envRef(env)} has no ${role} service.`, meta);
  }
  const tail = serviceLogTail(result.output, lines);
  return ok(
    compact({
      environment: envRef(env),
      role,
      lines: tail.log === "" ? 0 : tail.log.split("\n").length,
      since: sinceSeconds ? input.since?.trim() : null,
      log: tail.log === "" ? "(no log lines)" : tail.log,
      truncated: tail.truncated || null,
    }),
    withWithheld(meta, tail.redacted)
  );
}

async function getDeployTool(ctx: DataContext, rawId: string) {
  const id = rawId.trim();
  const { scope } = ctx.viewer;
  let deploy: Awaited<ReturnType<DataCores["getDeployment"]>>;
  try {
    deploy = await ctx.data.cores.getDeployment(scope, id);
  } catch (error) {
    if (isRefusal(error)) return fail(`Unknown deploy ${id}.`);
    throw error;
  }
  const env = (await ctx.data.environments()).find(
    (e) => e.id === deploy.environmentId
  );
  const meta: ToolMeta = env ? envMeta(env) : {};
  const run = deploy.runId
    ? await ctx.data.cores.getRunSnapshot(scope, deploy.runId)
    : null;
  const tail = run ? deployLogTail(run.output) : null;
  const error = safeText(run?.errorMessage, 2048);
  return ok(
    compact({
      ...deploySummary(deploy.componentKey, deploy),
      environment: env ? envRef(env) : null,
      error: error.text,
      log: tail?.log ?? null,
      logTruncated: tail?.truncated || null,
      // A run exists but its log is not readable for this user.
      logWithheld: deploy.runId !== null && run === null ? true : null,
    }),
    withWithheld(meta, (tail?.redacted ?? 0) + error.redacted)
  );
}

async function listBuildsTool(
  ctx: DataContext,
  given: string,
  rawLimit: number | null | undefined
) {
  const found = await projectByKey(ctx, given);
  if (typeof found === "string") {
    return fail(unknownProjectError(found, ctx.mode), { project: found });
  }
  const meta: ToolMeta = { project: found.key };
  let builds: Awaited<ReturnType<DataCores["listProjectBuilds"]>>;
  try {
    builds = await ctx.data.cores.listProjectBuilds(
      ctx.viewer.scope,
      found.id,
      clamp(rawLimit, DEFAULT_LIST_LIMIT, DATA_LIST_LIMIT)
    );
  } catch (error) {
    if (isRefusal(error)) {
      return fail(unknownProjectError(found.key, ctx.mode), meta);
    }
    throw error;
  }
  let withheld = 0;
  const data = builds.slice(0, DATA_LIST_LIMIT).map((b) => {
    const message = safeText(b.commitMessage, 160);
    withheld += message.redacted;
    return compact({
      component: b.componentKey,
      branch: b.branch,
      tag: b.tag,
      commit: short(b.commitSha),
      at: iso(b.receivedAt),
      by: b.pushedBy ?? b.commitAuthorEmail,
      message: message.text,
    });
  });
  return ok({ project: found.key, builds: data }, withWithheld(meta, withheld));
}

async function searchIssuesTool(
  ctx: DataContext,
  query: string,
  project: string | null | undefined
) {
  if (!query.trim()) return fail("query must not be empty");
  let projectId: string | undefined;
  let meta: ToolMeta = {};
  if (project) {
    const found = await projectByKey(ctx, project);
    if (typeof found === "string") {
      return fail(unknownProjectError(found, ctx.mode), { project: found });
    }
    projectId = found.id;
    meta = { project: found.key };
  }
  const page = await ctx.data.cores.listIssues(ctx.viewer.scope, {
    q: query.trim(),
    status: "all",
    ...(projectId ? { projectId } : {}),
    sort: "updatedAt",
    desc: true,
    limit: DATA_LIST_LIMIT,
  });
  let withheld = 0;
  const issues = page.rows.slice(0, DATA_LIST_LIMIT).map((i) => {
    const title = safeText(i.title);
    withheld += title.redacted;
    return compact({
      key: `${i.project.key}-${i.number}`,
      title: title.text,
      status: i.status,
      type: i.type,
      priority: i.priority,
      assignee: i.assignee?.name ?? null,
      environment: i.environment?.name ?? null,
      updatedAt: iso(i.updatedAt),
    });
  });
  return ok(
    { total: page.total, issues },
    withWithheld(
      { ...meta, issueKeys: issues.map((i) => String(i.key)) },
      withheld
    )
  );
}

const PANEL_ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-([1-9][0-9]{0,8})$/;

async function getPanelIssueTool(ctx: DataContext, rawKey: string) {
  const key = rawKey.trim().toUpperCase();
  const match = PANEL_ISSUE_KEY.exec(key);
  const notFound = fail(`Menara issue ${rawKey.trim()} not found.`);
  if (!match?.[1] || !match[2]) return notFound;
  const issue = await ctx.data.cores.getIssueDetail(
    ctx.viewer.scope,
    match[1],
    Number(match[2])
  );
  if (!issue) return notFound;
  const projectKey = issue.project.key;
  let withheld = 0;
  const text = (value: string | null | undefined, maxBytes?: number) => {
    const safe = safeText(value, maxBytes);
    withheld += safe.redacted;
    return safe.text;
  };
  const ref = (r: { number: number; title: string; status: string }) =>
    compact({
      key: `${projectKey}-${r.number}`,
      title: text(r.title),
      status: r.status,
    });
  const comments = issue.comments.slice(-MAX_ISSUE_COMMENTS).map((c) =>
    compact({
      author: c.author?.name ?? null,
      at: iso(c.createdAt),
      body: text(c.body, MAX_ISSUE_COMMENT_BYTES),
    })
  );
  const data = compact({
    key: `${projectKey}-${issue.number}`,
    project: projectKey,
    title: text(issue.title),
    status: issue.status,
    type: issue.type,
    priority: issue.priority,
    estimate: issue.estimate,
    environment: issue.environment?.name ?? null,
    assignee: issue.assignee?.name ?? null,
    createdBy: issue.createdBy?.name ?? null,
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    labels: issue.labels.map((l) => l.name),
    parent: issue.parent ? ref(issue.parent) : null,
    children: issue.children.map(ref),
    description: text(issue.description, MAX_ISSUE_DESCRIPTION_BYTES),
    comments,
    olderComments:
      issue.comments.length > comments.length
        ? issue.comments.length - comments.length
        : null,
  });
  return ok(
    data,
    withWithheld(
      { project: projectKey, issueKeys: [String(data.key)] },
      withheld
    )
  );
}

async function listPeopleTool(
  ctx: DataContext,
  project: string | null | undefined
) {
  let projectId: string | undefined;
  let meta: ToolMeta = {};
  if (project) {
    const found = await projectByKey(ctx, project);
    if (typeof found === "string") {
      return fail(unknownProjectError(found, ctx.mode), { project: found });
    }
    projectId = found.id;
    meta = { project: found.key };
  }
  let people: Awaited<ReturnType<DataCores["listPeople"]>>;
  try {
    people = await ctx.data.cores.listPeople(ctx.viewer.scope, projectId);
  } catch (error) {
    if (isRefusal(error) && meta.project) {
      return fail(unknownProjectError(meta.project, ctx.mode), meta);
    }
    throw error;
  }
  const keyOf = new Map(
    (await ctx.data.projects()).map((p) => [p.id, p.key] as const)
  );
  const shown = people.slice(0, MAX_PEOPLE);
  return ok(
    compact({
      people: shown.map((p) =>
        compact({
          name: p.name,
          callName: callName(p) === p.name ? null : callName(p),
          email: p.email,
          title: p.title,
          role: p.role,
          projects: p.projectIds.flatMap((id) => {
            const key = keyOf.get(id);
            return key ? [key] : [];
          }),
          deactivated: p.deactivated || null,
        })
      ),
      more: people.length > shown.length ? people.length - shown.length : null,
    }),
    meta
  );
}

async function listServersTool(ctx: DataContext) {
  const servers = await ctx.data.cores.getServers(ctx.viewer.scope);
  const shown = servers.slice(0, MAX_SERVERS);
  return ok(
    compact({
      servers: shown.map((s) =>
        compact({
          name: s.name,
          host: s.host,
          placement: s.placement,
          infraOnly: s.infraOnly || null,
        })
      ),
      more:
        servers.length > shown.length ? servers.length - shown.length : null,
    })
  );
}

async function getServerTool(ctx: DataContext, given: string) {
  const server = await ctx.data.cores.getServer(ctx.viewer.scope, given);
  if (!server)
    return fail(`Unknown server ${given.trim()}. Call list_servers.`);
  const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
  const preflight = server.preflight;
  return ok(
    compact({
      name: server.name,
      host: server.host,
      username: server.username,
      auth: server.auth,
      placement: server.placement,
      infraOnly: server.infraOnly || null,
      scannedAt: iso(server.preflightAt),
      runtime: preflight ? compact(preflight.runtime) : null,
      disk: preflight?.disk.map((d) => ({
        mount: d.mount,
        freeGiB: gib(d.freeBytes),
        totalGiB: gib(d.totalBytes),
      })),
    })
  );
}

async function recentActivityTool(
  ctx: DataContext,
  rawLimit: number | null | undefined
) {
  const rows = await ctx.data.cores.listActivity(
    ctx.viewer.scope,
    clamp(rawLimit, DEFAULT_ACTIVITY_LIMIT, ACTIVITY_LIMIT)
  );
  let withheld = 0;
  const entries = rows.slice(0, ACTIVITY_LIMIT).map((r) => {
    const details = Object.fromEntries(
      Object.entries(r.data ?? {}).map(([k, v]) => {
        if (typeof v === "number" || typeof v === "boolean" || v === null) {
          return [k, v];
        }
        // Nested values are sent as JSON text, filtered and capped too.
        const safe = safeText(typeof v === "string" ? v : JSON.stringify(v));
        withheld += safe.redacted;
        return [k, safe.text];
      })
    );
    return compact({
      action: r.action,
      by: r.actorName,
      at: iso(r.createdAt),
      details: Object.keys(details).length > 0 ? details : null,
    });
  });
  return ok({ entries }, withWithheld({}, withheld));
}

/** Runs a validated data tool call for one viewer. */
export async function runDataTool(
  name: DataToolName,
  data: unknown,
  ctx: DataContext
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "list_environments": {
      const i = data as z.infer<typeof DATA_INPUTS.list_environments>;
      return listEnvironmentsTool(ctx, i.project);
    }
    case "get_environment_status": {
      const i = data as z.infer<typeof DATA_INPUTS.get_environment_status>;
      return environmentStatusTool(ctx, i.environment);
    }
    case "list_deploys": {
      const i = data as z.infer<typeof DATA_INPUTS.list_deploys>;
      return listDeploysTool(ctx, i.environment, i.limit);
    }
    case "get_service_logs":
      return getServiceLogsTool(
        ctx,
        data as z.infer<typeof DATA_INPUTS.get_service_logs>
      );
    case "get_deploy": {
      const i = data as z.infer<typeof DATA_INPUTS.get_deploy>;
      return getDeployTool(ctx, i.id);
    }
    case "list_builds": {
      const i = data as z.infer<typeof DATA_INPUTS.list_builds>;
      return listBuildsTool(ctx, i.project, i.limit);
    }
    case "search_panel_issues": {
      const i = data as z.infer<typeof DATA_INPUTS.search_panel_issues>;
      return searchIssuesTool(ctx, i.query, i.project);
    }
    case "get_panel_issue": {
      const i = data as z.infer<typeof DATA_INPUTS.get_panel_issue>;
      return getPanelIssueTool(ctx, i.key);
    }
    case "list_people": {
      const i = data as z.infer<typeof DATA_INPUTS.list_people>;
      return listPeopleTool(ctx, i.project);
    }
    case "list_servers":
      return listServersTool(ctx);
    case "get_server": {
      const i = data as z.infer<typeof DATA_INPUTS.get_server>;
      return getServerTool(ctx, i.server);
    }
    case "recent_activity": {
      const i = data as z.infer<typeof DATA_INPUTS.recent_activity>;
      return recentActivityTool(ctx, i.limit);
    }
  }
}
