import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  notExists,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { recordActivity } from "@/lib/activity";
import { assignableUsersWhere } from "@/lib/assignees";
import { getServerSession, requireSession } from "@/lib/auth-session";
import {
  ForbiddenError,
  getProjectRole,
  projectScope,
  requireOrgPermission,
  requireProjectPermission,
} from "@/lib/authz";
import { db } from "@/lib/db";
import { one } from "@/lib/db/one";
import type {
  EnvironmentWithServers,
  SafeEnvironmentWithServers,
} from "@/lib/db/schema";
import {
  databaseHosts,
  deployTargets,
  type Environment,
  type EnvironmentListItem,
  environmentAccess,
  environmentMailpit,
  environmentServices,
  environments,
  environmentVariables,
  type NewEnvironmentService,
  projectMembers,
  projects,
  servers,
  users as userTable,
} from "@/lib/db/schema";
import {
  changedInfraFields,
  loadEnvironmentWithServers,
  loadSafeEnvironment,
  ownerIdToVerify,
} from "@/lib/environments";
import {
  canOrg,
  canPlaceEnvironment,
  type ProjectRole,
} from "@/lib/permissions";
import { RESERVED_ENV_SLUGS } from "@/lib/reserved-paths";
import { encryptNullable } from "@/lib/secrets";
import { findService, hasService, type ServiceRole } from "@/lib/services";
import type { ActionResponse } from "@/lib/types";
import type { EnvironmentInput } from "@/lib/validation";
import {
  environmentInputSchema,
  environmentUpdateSchema,
  sharedDatabaseNameSchema,
} from "@/lib/validation";
import { badRequest } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

// The form posts one flat payload (db*/backend*/frontend* fields); storage is
// one `environments` row plus one `environment_services` row per role. These
// helpers are the single place that mapping lives.
//
// Secret columns (the DB admin password, mock-time API key) are encrypted at rest
// here, mirroring the decrypt boundary in
// lib/environments#loadEnvironmentWithServers.

type ServiceValues = Omit<NewEnvironmentService, "environmentId">;
type EnvironmentUpdate = Partial<EnvironmentInput>;

// db and frontend are optional: the builders return undefined when a required
// field is absent (the input schema guarantees them whenever the matching
// flag is on; an update patch may omit them).
function dbServiceValues(d: EnvironmentUpdate): ServiceValues | undefined {
  if (
    !(
      d.dbServerId &&
      d.dbServiceType &&
      d.dbServiceName &&
      d.dbType &&
      d.dbName &&
      d.dbBackupPath
    )
  ) {
    return undefined;
  }
  return {
    role: "db",
    serverId: d.dbServerId,
    serviceType: d.dbServiceType,
    serviceName: d.dbServiceName,
    dbType: d.dbType,
    dbName: d.dbName,
    dbUser: d.dbUser,
    dbPassword: encryptNullable(d.dbPassword),
    dbBackupPath: d.dbBackupPath,
    dbKind: d.dbKind ?? null,
    databaseHostId: d.databaseHostId ?? null,
    dbRole: d.dbRole ?? null,
    dbPasswordVariable: d.dbPasswordVariable ?? null,
  };
}

function backendServiceValues(d: EnvironmentInput): ServiceValues {
  return {
    role: "backend",
    serverId: d.backendServerId,
    serviceType: d.backendServiceType,
    serviceName: d.backendServiceName,
    mockTimeApiUrl: d.backendMockTimeApiUrl,
    mockTimeApiKey: encryptNullable(d.backendMockTimeApiKey),
  };
}

function frontendServiceValues(
  d: EnvironmentUpdate
): ServiceValues | undefined {
  if (!(d.frontendServerId && d.frontendServiceType && d.frontendServiceName)) {
    return undefined;
  }
  return {
    role: "frontend",
    serverId: d.frontendServerId,
    serviceType: d.frontendServiceType,
    serviceName: d.frontendServiceName,
  };
}

// Partial-update variants: only keys actually present in the payload are
// carried over, so an edit that touches one field can't null out the rest.
// `undefined` values are dropped; an explicit null still clears a column.
function pickPresent<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

function dbServicePatch(d: EnvironmentUpdate) {
  return pickPresent({
    serverId: d.dbServerId,
    serviceType: d.dbServiceType,
    serviceName: d.dbServiceName,
    dbType: d.dbType,
    dbName: d.dbName,
    dbUser: d.dbUser,
    dbPassword: "dbPassword" in d ? encryptNullable(d.dbPassword) : undefined,
    dbBackupPath: d.dbBackupPath,
    dbKind: d.dbKind,
    databaseHostId: d.databaseHostId,
    dbRole: d.dbRole,
    dbPasswordVariable: d.dbPasswordVariable,
  });
}

function backendServicePatch(d: EnvironmentUpdate) {
  return pickPresent({
    serverId: d.backendServerId,
    serviceType: d.backendServiceType,
    serviceName: d.backendServiceName,
    mockTimeApiUrl: d.backendMockTimeApiUrl,
    mockTimeApiKey:
      "backendMockTimeApiKey" in d
        ? encryptNullable(d.backendMockTimeApiKey)
        : undefined,
  });
}

function frontendServicePatch(d: EnvironmentUpdate) {
  return pickPresent({
    serverId: d.frontendServerId,
    serviceType: d.frontendServiceType,
    serviceName: d.frontendServiceName,
  });
}

/**
 * GET: Fetch every environment (without server details — used for the header
 * picker, sidebar, etc. where only id+name matters).
 */
export async function listEnvironments(): Promise<EnvironmentListItem[]> {
  const session = await requireSession();
  try {
    // Order by the caller's recency (most-recently-opened first), falling back
    // to name for environments they've never opened. `nulls last` keeps unvisited
    // environments below visited ones instead of Postgres' default nulls-first.
    // Joins the owning project's `key` so consumers can build readable URLs
    // (/[key]/[slug]/…) without a second query, plus the `db` service's engine
    // and database name — the two service fields list views render, joined here
    // so the grid doesn't fetch services per row.
    return await db
      .select({
        ...getTableColumns(environments),
        key: projects.key,
        dbType: environmentServices.dbType,
        dbName: environmentServices.dbName,
        // Sidebar's Mail entry. EXISTS, not a join, so the secret columns
        // never enter this client-bound projection.
        hasMailpit: sql<boolean>`exists (select 1 from ${environmentMailpit} where ${environmentMailpit.environmentId} = ${environments.id})`,
        // Roles present, so the sidebar can hide sections the environment has
        // no service for. json_agg, not an array type, to keep driver parsing
        // out of the picture.
        serviceRoles: sql<
          ServiceRole[]
        >`coalesce((select json_agg(${environmentServices.role}) from ${environmentServices} where ${environmentServices.environmentId} = ${environments.id}), '[]'::json)`,
        // Already left-joined for the ordering below; null = never opened.
        lastAccessedAt: environmentAccess.lastAccessedAt,
      })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .leftJoin(
        environmentServices,
        and(
          eq(environmentServices.environmentId, environments.id),
          eq(environmentServices.role, "db")
        )
      )
      .leftJoin(
        environmentAccess,
        and(
          eq(environmentAccess.environmentId, environments.id),
          eq(environmentAccess.userId, session.user.id)
        )
      )
      .where(await projectScope(environments.projectId))
      .orderBy(
        sql`${environmentAccess.lastAccessedAt} desc nulls last`,
        asc(environments.name)
      );
  } catch (error) {
    console.error("Failed to fetch environments:", error);
    return [];
  }
}

/**
 * Record that the current user just opened an environment, bumping its recency
 * so the header switcher surfaces it first next time. Fire-and-forget: any
 * failure is logged, never thrown, so it can't break an environment page render.
 */
export async function recordEnvironmentAccess(
  environmentId: string
): Promise<void> {
  const session = await getServerSession();
  if (!session) return;
  // Only environments the caller can see; also rejects non-uuid ids.
  if (!(await getProjectRole({ environmentId }))) return;
  try {
    await db
      .insert(environmentAccess)
      .values({ userId: session.user.id, environmentId })
      .onConflictDoUpdate({
        target: [environmentAccess.userId, environmentAccess.environmentId],
        set: { lastAccessedAt: sql`now()` },
      });
  } catch (error) {
    console.error("Failed to record environment access:", error);
  }
}

/**
 * Per-user "recently opened" timestamps (epoch ms) keyed by environment id, for
 * the environment list's "Recently opened" sort. Mirrors the header switcher's
 * MRU but as a map the client can sort by. Missing entry = never opened by this
 * user.
 */
export async function getEnvironmentsLastOpened(): Promise<
  Record<string, number>
> {
  const session = await getServerSession();
  if (!session) return {};
  try {
    const rows = await db
      .select({
        environmentId: environmentAccess.environmentId,
        lastAccessedAt: environmentAccess.lastAccessedAt,
      })
      .from(environmentAccess)
      .innerJoin(
        environments,
        eq(environments.id, environmentAccess.environmentId)
      )
      .where(
        and(
          eq(environmentAccess.userId, session.user.id),
          await projectScope(environments.projectId)
        )
      );
    const map: Record<string, number> = {};
    for (const r of rows) map[r.environmentId] = r.lastAccessedAt.getTime();
    return map;
  } catch (error) {
    console.error("Failed to fetch environment open times:", error);
    return {};
  }
}

/**
 * GET: Fetch a single environment by ID with its three server relations loaded.
 * Returns a CREDENTIAL-FREE projection — SSH/DB passwords and the mock-time API
 * key are stripped before the data crosses to the client. Actions that need the
 * real credentials re-load them server-side via lib/environments.
 */
export async function getEnvironmentById(
  id: string
): Promise<SafeEnvironmentWithServers | undefined> {
  await requireSession();
  if (!(await getProjectRole({ environmentId: id }))) return undefined;
  try {
    return (await loadSafeEnvironment(id)) ?? undefined;
  } catch (error) {
    console.error(`Failed to fetch environment ${id}:`, error);
    return undefined;
  }
}

/**
 * CREATE: Add a new environment. Server FKs (dbServerId, backendServerId,
 * frontendServerId) must already exist — create them via createServer first.
 */
// URL-friendly base slug from an environment name.
function baseSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "env"
  );
}

// A slug unique within the project — append -2, -3, … on collision. Slugs that
// would shadow one of the project's own sub-routes are treated as taken, so an
// environment named "Issues" becomes `issues-2` instead of an unreachable page.
async function uniqueEnvSlug(projectId: string, name: string): Promise<string> {
  const base = baseSlug(name);
  const existing = await db
    .select({ slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const taken = new Set([
    ...existing.map((e) => e.slug),
    ...RESERVED_ENV_SLUGS,
  ]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// An owner must be someone who can be assigned issues in the environment's
// project: a non-banned org admin/infra or a member of it (the same predicate
// as listAssignableUsers, which feeds the form's owner picker).
async function canOwnEnvironment(
  ownerId: string,
  projectId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(
      and(
        eq(userTable.id, ownerId),
        assignableUsersWhere(eq(projectMembers.projectId, projectId))
      )
    )
    .limit(1);
  return !!row;
}

// Refuse (400) an owner who isn't eligible for `projectId`.
async function requireEligibleOwner(
  ownerId: string | null,
  projectId: string
): Promise<void> {
  if (!ownerId || (await canOwnEnvironment(ownerId, projectId))) return;
  const t = await getServerTranslator("actionErrors");
  badRequest(t("environmentOwnerIneligible"));
}

// A service an environment binds: the server and the service name that
// service control, logs and database backup/restore then act on. A shared
// database binding also names its database host, database and role.
type SharedDb = { hostId: string; dbName: string; dbRole: string | null };
type Binding = { serverId: string; serviceName: string; sharedDb?: SharedDb };

function sharedDbOf(d: {
  dbKind?: string | null;
  databaseHostId?: string | null;
  dbName?: string | null;
  dbRole?: string | null;
}): SharedDb | undefined {
  return d.dbKind === "shared" && d.databaseHostId && d.dbName
    ? { hostId: d.databaseHostId, dbName: d.dbName, dbRole: d.dbRole ?? null }
    : undefined;
}

// The bindings of a new environment: backend always, db and frontend when the
// payload enables them (the same rule the service rows follow).
function createdBindings(input: EnvironmentInput): Binding[] {
  return [
    input.hasDatabase && input.dbServerId && input.dbServiceName
      ? {
          serverId: input.dbServerId,
          serviceName: input.dbServiceName,
          sharedDb: sharedDbOf(input),
        }
      : undefined,
    { serverId: input.backendServerId, serviceName: input.backendServiceName },
    input.hasFrontend && input.frontendServerId && input.frontendServiceName
      ? {
          serverId: input.frontendServerId,
          serviceName: input.frontendServiceName,
        }
      : undefined,
  ].filter((b): b is Binding => b !== undefined);
}

const BINDING_FIELDS = {
  db: ["dbServerId", "dbServiceName"],
  backend: ["backendServerId", "backendServiceName"],
  frontend: ["frontendServerId", "frontendServiceName"],
} as const satisfies Record<ServiceRole, readonly [string, string]>;

function bindingFlag(input: EnvironmentUpdate, role: ServiceRole) {
  if (role === "db") return input.hasDatabase;
  if (role === "frontend") return input.hasFrontend;
  return undefined;
}

// The bindings an update leaves the environment with: stored services patched
// by the payload, minus the ones it turns off, plus the ones it turns on.
function updatedBindings(
  input: EnvironmentUpdate,
  stored: EnvironmentWithServers
): Binding[] {
  const bindings: Binding[] = [];
  for (const role of ["db", "backend", "frontend"] as const) {
    const flag = bindingFlag(input, role);
    const service = findService(stored, role);
    if (flag === false || (!service && flag !== true)) continue;
    const [serverKey, nameKey] = BINDING_FIELDS[role];
    const serverId = input[serverKey] ?? service?.serverId;
    const serviceName = input[nameKey] ?? service?.serviceName;
    if (!(serverId && serviceName)) continue;
    const sharedDb =
      role === "db" ? sharedDbOf(effectiveDbFields(input, service)) : undefined;
    bindings.push({ serverId, serviceName, sharedDb });
  }
  return bindings;
}

type StoredDbFields = {
  dbKind?: string | null;
  databaseHostId?: string | null;
  dbName?: string | null;
  dbRole?: string | null;
};

// The db binding fields an update leaves: the payload's where present, else
// the stored ones.
function effectiveDbFields(
  input: EnvironmentUpdate,
  service: StoredDbFields | undefined
): StoredDbFields {
  const pick = <K extends keyof StoredDbFields>(key: K) =>
    input[key] !== undefined ? input[key] : (service?.[key] ?? null);
  return {
    dbKind: pick("dbKind"),
    databaseHostId: pick("databaseHostId"),
    dbName: pick("dbName"),
    dbRole: pick("dbRole"),
  };
}

// True when the update sets a shared binding's kind, host, database or role
// to something other than what is stored.
function changesSharedDb(
  input: EnvironmentUpdate,
  stored: EnvironmentWithServers
): boolean {
  const service = findService(stored, "db");
  return (["dbKind", "databaseHostId", "dbName", "dbRole"] as const).some(
    (key) => input[key] !== undefined && input[key] !== (service?.[key] ?? null)
  );
}

const DB_INPUT_KEYS = [
  "dbServerId",
  "dbServiceType",
  "dbServiceName",
  "dbType",
  "dbName",
  "dbBackupPath",
  "dbKind",
  "databaseHostId",
  "dbRole",
  "dbPasswordVariable",
] as const;

/**
 * A shared database binding takes its server, container, engine and backup
 * path from its database host; whatever the client sent for those is
 * replaced. The host is named by `databaseHostId`, or by the server and
 * container (`dbServerId` + `dbServiceName`) of a registered host. Any other
 * kind keeps the client's values and drops a host reference. On an update the
 * stored kind and host apply when the payload does not change them. Returns
 * the payload to store; 400 when a shared binding names no registered host.
 */
async function withDerivedDbBinding<T extends EnvironmentUpdate>(
  input: T,
  stored?: EnvironmentWithServers
): Promise<T> {
  const service = stored ? findService(stored, "db") : undefined;
  const touchesDb =
    input.hasDatabase === true ||
    DB_INPUT_KEYS.some((k) => input[k] !== undefined);
  if (!touchesDb || input.hasDatabase === false) return input;
  const kind =
    input.dbKind !== undefined ? input.dbKind : (service?.dbKind ?? null);
  if (kind !== "shared") {
    return input.dbKind !== undefined
      ? { ...input, databaseHostId: null }
      : input;
  }
  const host = await findDatabaseHost(
    input.databaseHostId
      ? { id: input.databaseHostId }
      : input.dbServerId && input.dbServiceName
        ? { serverId: input.dbServerId, containerName: input.dbServiceName }
        : service?.databaseHostId
          ? { id: service.databaseHostId }
          : null
  );
  if (!host) {
    const t = await getServerTranslator("actionErrors");
    badRequest(t("databaseHostNotFound"));
  }
  return {
    ...input,
    dbKind: "shared",
    databaseHostId: host.id,
    dbServerId: host.serverId,
    dbServiceType: "docker",
    dbServiceName: host.containerName,
    dbType: "postgres",
    dbBackupPath: host.backupPath,
  };
}

async function findDatabaseHost(
  ref: { id: string } | { serverId: string; containerName: string } | null
) {
  if (!ref) return undefined;
  const [host] = await db
    .select()
    .from(databaseHosts)
    .where(
      "id" in ref
        ? eq(databaseHosts.id, ref.id)
        : and(
            eq(databaseHosts.serverId, ref.serverId),
            eq(databaseHosts.containerName, ref.containerName)
          )
    )
    .limit(1);
  return host;
}

/**
 * The database and role of a shared binding are named
 * `<project key lowercased>_<suffix>` (400 otherwise), whoever binds them.
 */
async function requireSharedDbNames(
  projectId: string,
  sharedDb: SharedDb | undefined
): Promise<void> {
  if (!sharedDb) return;
  const prefix = await sharedDbPrefix(projectId);
  const names = [sharedDb.dbName, sharedDb.dbRole];
  if (names.every((n) => n !== null && hasSharedDbPrefix(n, prefix))) return;
  const t = await getServerTranslator("actionErrors");
  badRequest(t("sharedDatabaseNamePrefix", { prefix: prefix ?? "" }));
}

async function projectKeyOf(projectId: string): Promise<string | null> {
  const [project] = await db
    .select({ key: projects.key })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project ? project.key.toLowerCase() : null;
}

async function sharedDbPrefix(projectId: string): Promise<string | null> {
  const key = await projectKeyOf(projectId);
  return key === null ? null : `${key}_`;
}

function hasSharedDbPrefix(name: string, prefix: string | null): boolean {
  return (
    prefix !== null &&
    sharedDatabaseNameSchema.safeParse(name).success &&
    name.startsWith(prefix) &&
    name.length > prefix.length
  );
}

// True when the update adds a service or points one at another server or
// service name.
function changesBindings(
  input: EnvironmentUpdate,
  stored: EnvironmentWithServers
): boolean {
  return (["db", "backend", "frontend"] as const).some((role) => {
    const service = findService(stored, role);
    if (bindingFlag(input, role) === true && !service) return true;
    const [serverKey, nameKey] = BINDING_FIELDS[role];
    return (
      (input[serverKey] !== undefined &&
        input[serverKey] !== service?.serverId) ||
      (input[nameKey] !== undefined && input[nameKey] !== service?.serviceName)
    );
  });
}

// Binding servers and service names gives service control, logs and database
// backup/restore over them, so a placement is checked like this:
// - every bound server must admit the caller under its placement policy
//   (lib/permissions#canPlaceEnvironment); a server not found is restricted;
// - on an open server, a caller without org server:manage may only bind
//   service names that start with the project's key lowercased plus "-"
//   (`hris-backend` in HRIS) and that no other environment on that server
//   uses, so an open placement never reaches another environment's
//   containers or databases, nor an unregistered container (the Panel's own
//   database, ZITADEL, the CI server);
// - the one exception is a shared database binding: its container is a
//   registered database host (withDerivedDbBinding resolved it), so the
//   caller may bind it unprefixed, provided its database and role are named
//   `<key>_…` and no other environment on that host uses either. Database
//   operations on it are then confined to those names
//   (lib/provisioning/database#allowedDatabaseName).
// Changing a server's placement re-checks nothing: only new placements.
async function requireEnvironmentPlacement(
  orgRole: string | null | undefined,
  projectId: string,
  projectRole: ProjectRole,
  bindings: Binding[],
  exceptEnvironmentId?: string
): Promise<void> {
  const serverIds = [...new Set(bindings.map((b) => b.serverId))];
  const rows = serverIds.length
    ? await db
        .select({ id: servers.id, placement: servers.placement })
        .from(servers)
        .where(inArray(servers.id, serverIds))
    : [];
  const placementOf = new Map(rows.map((r) => [r.id, r.placement]));
  const allowed = serverIds.every((id) =>
    canPlaceEnvironment(
      orgRole,
      projectRole,
      placementOf.get(id) ?? "restricted"
    )
  );
  if (!allowed) throw new ForbiddenError();
  if (canOrg(orgRole, { server: ["manage"] })) return;
  const openIds = serverIds.filter((id) => placementOf.get(id) === "open");
  if (openIds.length === 0) return;
  const onOpen = bindings.filter((b) => openIds.includes(b.serverId));
  const services = onOpen.filter((b) => !b.sharedDb);
  const shared = onOpen.filter((b) => b.sharedDb);
  const key = await projectKeyOf(projectId);
  const prefix = key === null ? null : `${key}-`;
  const unprefixed = services.some(
    (b) =>
      prefix === null ||
      !b.serviceName.startsWith(prefix) ||
      b.serviceName.length === prefix.length
  );
  if (unprefixed) {
    const t = await getServerTranslator("actionErrors");
    throw new ForbiddenError(
      t("placementServiceName", { prefix: prefix ?? "" })
    );
  }
  const dbPrefix = key === null ? null : `${key}_`;
  const badDbName = shared.some(
    ({ sharedDb }) =>
      !(
        sharedDb &&
        hasSharedDbPrefix(sharedDb.dbName, dbPrefix) &&
        sharedDb.dbRole !== null &&
        hasSharedDbPrefix(sharedDb.dbRole, dbPrefix)
      )
  );
  if (badDbName) {
    const t = await getServerTranslator("actionErrors");
    throw new ForbiddenError(
      t("placementDatabaseName", { prefix: dbPrefix ?? "" })
    );
  }
  const used = (
    await db
      .select({
        environmentId: environmentServices.environmentId,
        serverId: environmentServices.serverId,
        serviceName: environmentServices.serviceName,
        databaseHostId: environmentServices.databaseHostId,
        dbName: environmentServices.dbName,
        dbRole: environmentServices.dbRole,
        dbUser: environmentServices.dbUser,
      })
      .from(environmentServices)
      .where(inArray(environmentServices.serverId, openIds))
  ).filter((u) => u.environmentId !== exceptEnvironmentId);
  const clash = services.some((b) =>
    used.some(
      (u) => u.serverId === b.serverId && u.serviceName === b.serviceName
    )
  );
  if (clash) {
    const t = await getServerTranslator("actionErrors");
    throw new ForbiddenError(t("placementServiceInUse"));
  }
  // Another environment in the same container (bound to the host, or bound
  // to its server and container name before the host was registered) whose
  // database is this one's or overlaps it (`X` vs `X_…`, the backup file
  // prefix), or whose database, role or legacy login is this one's role.
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}_`) || b.startsWith(`${a}_`);
  const dbClash = shared.some(({ serverId, serviceName, sharedDb }) =>
    used.some(
      (u) =>
        sharedDb &&
        (u.databaseHostId === sharedDb.hostId ||
          (u.serverId === serverId && u.serviceName === serviceName)) &&
        ((u.dbName != null && overlaps(u.dbName, sharedDb.dbName)) ||
          (sharedDb.dbRole !== null &&
            [u.dbName, u.dbRole, u.dbUser].includes(sharedDb.dbRole)))
    )
  );
  if (dbClash) {
    const t = await getServerTranslator("actionErrors");
    throw new ForbiddenError(t("placementDatabaseInUse"));
  }
}

export async function createEnvironment(
  data: unknown
): Promise<ActionResponse<Environment>> {
  const parsed = environmentInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid environment data" };
  }
  // Visibility first (404 for an invisible project), then the placement rule
  // of the chosen servers decides who may create here.
  const { session, role } = await requireProjectPermission(
    { projectId: parsed.data.projectId },
    { project: ["read"] }
  );
  const input = await withDerivedDbBinding(parsed.data);
  await requireEnvironmentPlacement(
    session.user.role,
    input.projectId,
    role,
    createdBindings(input)
  );
  if (input.hasDatabase) {
    await requireSharedDbNames(input.projectId, sharedDbOf(input));
  }
  await requireEligibleOwner(ownerIdToVerify(input), input.projectId);
  try {
    const slug = await uniqueEnvSlug(input.projectId, input.name);
    // One transaction: an environment without its services is unusable, so the
    // four inserts must land together.
    const insertedEnvironment = await db.transaction(async (tx) => {
      const env = one(
        await tx
          .insert(environments)
          .values({
            projectId: input.projectId,
            name: input.name,
            slug,
            kind: input.kind,
            // The creator owns the environment unless the form names someone.
            ownerId: input.ownerId ?? session.user.id,
            host: input.host,
            url: input.url,
          })
          .returning(),
        "environment"
      );
      const services = [
        input.hasDatabase ? dbServiceValues(input) : undefined,
        backendServiceValues(input),
        input.hasFrontend ? frontendServiceValues(input) : undefined,
      ].filter((s): s is ServiceValues => s !== undefined);
      await tx
        .insert(environmentServices)
        .values(services.map((s) => ({ ...s, environmentId: env.id })));
      return env;
    });

    return {
      success: true,
      message: "Environment created successfully",
      data: insertedEnvironment,
    };
  } catch (error) {
    console.error("Failed to create environment:", error);
    return { success: false, message: "Failed to create environment" };
  }
}

export async function updateEnvironment(
  id: string,
  data: unknown
): Promise<ActionResponse<Environment>> {
  const { session, role } = await requireProjectPermission(
    { environmentId: id },
    { environment: ["update"] }
  );
  const parsed = environmentUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid environment data" };
  }
  // Rebinding infrastructure (servers, service names, database credentials,
  // the mock-time URL) needs org server:manage. Only fields whose value really
  // changes count, so a maintainer re-saving the full form is still fine.
  const stored = await loadEnvironmentWithServers(id);
  if (!stored) return { success: false, message: "Environment not found" };
  // A shared database binding's server, container, engine and backup path
  // come from its host, before anything compares them with the stored ones.
  const input = await withDerivedDbBinding(parsed.data, stored);
  const removesService =
    (input.hasDatabase === false && hasService(stored, "db")) ||
    (input.hasFrontend === false && hasService(stored, "frontend"));
  if (removesService || changedInfraFields(input, stored).length > 0) {
    await requireOrgPermission({ server: ["manage"] });
  }
  // A deploy that backs up first needs the db service; dropping it would make
  // every later deploy of that target fail.
  if (input.hasDatabase === false && hasService(stored, "db")) {
    const [backupTarget] = await db
      .select({ id: deployTargets.id })
      .from(deployTargets)
      .where(
        and(
          eq(deployTargets.environmentId, id),
          eq(deployTargets.backupBeforeDeploy, true)
        )
      )
      .limit(1);
    if (backupTarget) {
      const t = await getServerTranslator("actionErrors");
      throw new HTTPException(409, {
        message: t("backupTargetsBlockDatabaseRemoval"),
      });
    }
  }
  // Moving an environment into another project is a placement there: the
  // caller's role in the target project must pass the placement rule of the
  // servers the environment ends up bound to. A binding change within the
  // project is checked the same way against the current project role.
  const targetProjectId = input.projectId;
  if (targetProjectId !== undefined && targetProjectId !== stored.projectId) {
    const { role: targetRole } = await requireProjectPermission(
      { projectId: targetProjectId },
      { project: ["read"] }
    );
    await requireEnvironmentPlacement(
      session.user.role,
      targetProjectId,
      targetRole,
      updatedBindings(input, stored),
      id
    );
  } else if (changesBindings(input, stored)) {
    await requireEnvironmentPlacement(
      session.user.role,
      stored.projectId,
      role,
      updatedBindings(input, stored),
      id
    );
  }
  await requireEligibleOwner(
    ownerIdToVerify(input, stored),
    input.projectId ?? stored.projectId
  );
  if (changesSharedDb(input, stored)) {
    await requireSharedDbNames(
      input.projectId ?? stored.projectId,
      sharedDbOf(effectiveDbFields(input, findService(stored, "db")))
    );
  }
  try {
    const envPatch = pickPresent({
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      ownerId: input.ownerId,
      host: input.host,
      url: input.url,
    });
    // Optional services: a flag turned off drops the role's row, turned on
    // while the row is missing inserts it from the payload (all required
    // fields must be present), and an absent flag is today's partial patch.
    const optional = [
      {
        role: "db" as const,
        flag: input.hasDatabase,
        values: dbServiceValues(input),
        patch: dbServicePatch(input),
        missingMessage: "Database fields are required",
      },
      {
        role: "frontend" as const,
        flag: input.hasFrontend,
        values: frontendServiceValues(input),
        patch: frontendServicePatch(input),
        missingMessage: "Frontend fields are required",
      },
    ];
    const servicePatches: { role: ServiceRole; patch: object }[] = [
      { role: "backend", patch: backendServicePatch(input) },
    ];
    const removeRoles: ServiceRole[] = [];
    const insertValues: ServiceValues[] = [];
    for (const { role, flag, values, patch, missingMessage } of optional) {
      if (flag === false) {
        removeRoles.push(role);
      } else if (flag === true && !hasService(stored, role)) {
        if (!values) return { success: false, message: missingMessage };
        insertValues.push(values);
      } else {
        servicePatches.push({ role, patch });
      }
    }
    const patchesToApply = servicePatches.filter(
      ({ patch }) => Object.keys(patch).length > 0
    );

    const updatedEnvironment = await db.transaction(async (tx) => {
      // Always re-read the row so a services-only edit still reports "not found"
      // for a bad id; only issue the UPDATE when the env itself changed.
      const [env] = Object.keys(envPatch).length
        ? await tx
            .update(environments)
            .set(envPatch)
            .where(eq(environments.id, id))
            .returning()
        : await tx.select().from(environments).where(eq(environments.id, id));
      if (!env) return undefined;

      for (const role of removeRoles) {
        await tx
          .delete(environmentServices)
          .where(
            and(
              eq(environmentServices.environmentId, id),
              eq(environmentServices.role, role)
            )
          );
      }
      if (insertValues.length > 0) {
        await tx
          .insert(environmentServices)
          .values(insertValues.map((v) => ({ ...v, environmentId: id })));
      }
      for (const { role, patch } of patchesToApply) {
        await tx
          .update(environmentServices)
          .set(patch)
          .where(
            and(
              eq(environmentServices.environmentId, id),
              eq(environmentServices.role, role)
            )
          );
      }
      return env;
    });

    if (!updatedEnvironment) {
      return { success: false, message: "Environment not found" };
    }

    // An edit can move the environment to another project or rename it, which
    // changes its readable URL — revalidate the whole tree rather than guessing
    // the old /[projectKey]/[envSlug] path.

    return {
      success: true,
      message: "Environment updated successfully",
      data: updatedEnvironment,
    };
  } catch (error) {
    console.error(`Failed to update environment ${id}:`, error);
    return { success: false, message: "Failed to update environment" };
  }
}

/**
 * Deletes an environment; its services, deploy targets and variables go with
 * it. Escrowed variables (e.g. a data encryption key) exist nowhere else, so
 * while the environment has any the delete is refused (409) unless an admin
 * with org integration:manage passes `confirmEscrowedDeletion`. The delete
 * itself re-checks escrow, so a variable escrowed after the check still
 * blocks it. A delete that removes variables is recorded in the activity
 * feed with their names and count, never their values.
 */
export async function deleteEnvironment(
  id: string,
  {
    confirmEscrowedDeletion = false,
  }: { confirmEscrowedDeletion?: boolean } = {}
): Promise<ActionResponse> {
  const { session } = await requireProjectPermission(
    { environmentId: id },
    { environment: ["delete"] }
  );
  const variables = await db
    .select({
      name: environmentVariables.name,
      escrow: environmentVariables.escrow,
    })
    .from(environmentVariables)
    .where(eq(environmentVariables.environmentId, id))
    .orderBy(asc(environmentVariables.name));
  const confirmed =
    confirmEscrowedDeletion &&
    canOrg(session.user.role, { integration: ["manage"] });
  const refuseEscrowed = async (): Promise<never> => {
    const t = await getServerTranslator("actionErrors");
    throw new HTTPException(409, {
      message: t("environmentHasEscrowedVariables"),
    });
  };
  if (!confirmed && variables.some((v) => v.escrow)) await refuseEscrowed();

  let deleted: { name: string } | undefined;
  try {
    [deleted] = await db
      .delete(environments)
      .where(
        confirmed
          ? eq(environments.id, id)
          : and(
              eq(environments.id, id),
              notExists(
                db
                  .select({ id: environmentVariables.id })
                  .from(environmentVariables)
                  .where(
                    and(
                      eq(environmentVariables.environmentId, id),
                      eq(environmentVariables.escrow, true)
                    )
                  )
              )
            )
      )
      .returning({ name: environments.name });
  } catch (error) {
    console.error(`Failed to delete environment ${id}:`, error);
    return { success: false, message: "Failed to delete environment" };
  }
  // The environment exists (the guard found it): nothing deleted means a
  // variable was escrowed since the check.
  if (!deleted) {
    if (!confirmed) await refuseEscrowed();
    return { success: false, message: "Environment not found" };
  }
  if (variables.length > 0) {
    await recordActivity({
      actorId: session.user.id,
      action: "environment.deletedWithVariables",
      entityType: "environment",
      entityId: id,
      data: {
        environment: deleted.name,
        count: variables.length,
        names: variables.map((v) => v.name).join(", "),
      },
    });
  }
  return { success: true, message: "Environment deleted successfully" };
}
