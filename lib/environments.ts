import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type {
  EnvironmentWithServers,
  SafeEnvironmentWithServers,
  SafeServer,
  SafeServiceWithServer,
  Server,
  ServiceWithServer,
} from "@/lib/db/schema";
import { environments, projects } from "@/lib/db/schema";
import { qualifiedEnvName } from "@/lib/nav-path";
import { decryptNullable, decryptSecret } from "@/lib/secrets";
import type { EnvironmentInput } from "@/lib/validation";

/**
 * Load an environment (deployment) together with its services and each
 * service's server — including SSH/DB credentials. SERVER-ONLY: the result
 * carries plaintext passwords and the mock-time API key, so it must never be
 * returned to a client component or a background-job payload. Actions take an
 * id from the client (route param `[projectId]`, historically the deployment
 * id) and call this to re-resolve the trusted record server-side; never trust
 * an object sent up from the browser.
 */
export async function loadEnvironmentWithServers(
  id: string
): Promise<EnvironmentWithServers | null> {
  const env = await loadEncryptedEnvironment(id);
  if (!env) return null;
  // SINGLE decryption boundary for environment credentials: secrets are stored
  // encrypted at rest (lib/secrets) and handed to trusted server-side callers
  // (SSH/DB ops, mock-time) as plaintext here. Every consumer that needs a
  // credential loads through this function, so nothing downstream deals with
  // ciphertext.
  return {
    ...env,
    services: env.services.map(decryptService),
  };
}

// The owner fields every environment view reads (see EnvironmentOwner).
export const OWNER_COLUMNS = {
  id: true,
  name: true,
  image: true,
  banned: true,
} as const;

/**
 * The stored row with its secret columns still encrypted. Same shape as
 * EnvironmentWithServers, but the password and API-key fields hold ciphertext,
 * so it must only be decrypted (above) or sanitized (loadSafeEnvironment).
 */
async function loadEncryptedEnvironment(
  id: string
): Promise<EnvironmentWithServers | null> {
  const environment = await db.query.environments.findFirst({
    where: { id },
    with: {
      services: {
        with: { server: true },
      },
      owner: { columns: OWNER_COLUMNS },
    },
  });
  return (environment as EnvironmentWithServers | undefined) ?? null;
}

/** Decrypt a service's own secrets and its server's SSH password. */
function decryptService(service: ServiceWithServer): ServiceWithServer {
  return {
    ...service,
    dbPassword: decryptNullable(service.dbPassword),
    mockTimeApiKey: decryptNullable(service.mockTimeApiKey),
    server: decryptServer(service.server),
  };
}

/** Decrypt a server's SSH password in place for server-side use. */
function decryptServer(server: Server): Server {
  return { ...server, password: decryptSecret(server.password) };
}

function stripServer(server: Server): SafeServer {
  const { password: _password, ...safe } = server;
  return safe;
}

/** Drop a service's secrets, keeping presence flags for the edit forms. */
function stripService(service: ServiceWithServer): SafeServiceWithServer {
  const { dbPassword, mockTimeApiKey, server, ...rest } = service;
  return {
    ...rest,
    server: stripServer(server),
    hasDbPassword: Boolean(dbPassword),
    hasMockTimeApiKey: Boolean(mockTimeApiKey),
  };
}

/**
 * Drop every secret from a fully-loaded environment so the result is safe to send
 * to a client component (and thus serialize into the RSC payload). Strips each
 * service's SSH password, the DB admin password, and the mock-time API key.
 */
export function sanitizeEnvironment(
  environment: EnvironmentWithServers
): SafeEnvironmentWithServers {
  return {
    ...environment,
    services: environment.services.map(stripService),
  };
}

/**
 * Load an environment and sanitize it in one step for handing to the client.
 * Never decrypts: sanitizing drops every secret anyway, and the presence flags
 * read the same from ciphertext (encryptNullable keeps null/"" as-is). So a
 * secret that can't be decrypted — a rotated SECRETS_KEY, a corrupt value, a
 * local dev server with its own key — doesn't take the whole page down.
 */
export async function loadSafeEnvironment(
  id: string
): Promise<SafeEnvironmentWithServers | null> {
  const environment = await loadEncryptedEnvironment(id);
  return environment ? sanitizeEnvironment(environment) : null;
}

/**
 * An environment's project-qualified display name ("Sucor Membership · Dev 1"),
 * for activity-log params and other text read outside the project's own pages.
 */
export async function environmentName(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ name: environments.name, projectName: projects.name })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(eq(environments.id, id))
    .limit(1);
  return row ? qualifiedEnvName(row.name, row.projectName) : undefined;
}

// Every form field that binds an environment to infrastructure, mapped to the
// service role and column it is stored in. Changing any of these can point the
// environment's service control, database drop/restore, logs or mock-time
// requests at different targets, so it needs org server:manage on top of
// environment:update. Only projectId/name/kind/ownerId/host/url are not listed
// here.
export const INFRA_FIELDS = {
  dbServerId: ["db", "serverId"],
  dbServiceType: ["db", "serviceType"],
  dbServiceName: ["db", "serviceName"],
  dbType: ["db", "dbType"],
  dbName: ["db", "dbName"],
  dbUser: ["db", "dbUser"],
  dbPassword: ["db", "dbPassword"],
  dbBackupPath: ["db", "dbBackupPath"],
  backendServerId: ["backend", "serverId"],
  backendServiceType: ["backend", "serviceType"],
  backendServiceName: ["backend", "serviceName"],
  backendMockTimeApiUrl: ["backend", "mockTimeApiUrl"],
  backendMockTimeApiKey: ["backend", "mockTimeApiKey"],
  frontendServerId: ["frontend", "serverId"],
  frontendServiceType: ["frontend", "serviceType"],
  frontendServiceName: ["frontend", "serviceName"],
} as const satisfies Partial<
  Record<
    keyof EnvironmentInput,
    readonly ["db" | "backend" | "frontend", keyof ServiceWithServer]
  >
>;

// Never compared with the stored value: "equal → allowed, different →
// forbidden" would let a caller without server:manage confirm a guessed
// password or API key. Submitting one at all counts as a change.
const SECRET_INFRA_FIELDS: ReadonlySet<keyof typeof INFRA_FIELDS> = new Set([
  "dbPassword",
  "backendMockTimeApiKey",
]);

/**
 * Pure: the infrastructure fields an update payload actually changes, compared
 * with the stored (decrypted) environment. Absent keys are untouched; null and
 * undefined/absent stored values compare equal, so re-submitting the form with
 * the bindings unchanged reports nothing. A missing service row counts every
 * submitted field for it as a change, and so does any submitted secret.
 */
export function changedInfraFields(
  input: Partial<EnvironmentInput>,
  stored: Pick<EnvironmentWithServers, "services">
): (keyof typeof INFRA_FIELDS)[] {
  const changed: (keyof typeof INFRA_FIELDS)[] = [];
  for (const [field, [role, column]] of Object.entries(INFRA_FIELDS) as [
    keyof typeof INFRA_FIELDS,
    (typeof INFRA_FIELDS)[keyof typeof INFRA_FIELDS],
  ][]) {
    if (!(field in input) || input[field] === undefined) continue;
    if (SECRET_INFRA_FIELDS.has(field)) {
      changed.push(field);
      continue;
    }
    const service = stored.services.find((s) => s.role === role);
    const next = input[field] ?? null;
    const current = service ? (service[column] ?? null) : undefined;
    if (current === undefined || next !== current) changed.push(field);
  }
  return changed;
}

/**
 * Pure: the owner id an environment write must check for eligibility (see
 * server/services/environments#canOwnEnvironment), or null when there is
 * nothing to check. A create checks any owner it sets. An update checks the
 * resulting owner when it changes, or when the environment moves to another
 * project (the kept owner must be eligible there too). An unchanged owner in
 * the same project is not re-checked, so an owner who has since been
 * deactivated doesn't block saving the rest of the form.
 */
export function ownerIdToVerify(
  input: { projectId?: string; ownerId?: string | null },
  stored?: { projectId: string; ownerId: string | null }
): string | null {
  if (!stored) return input.ownerId ?? null;
  const ownerId = input.ownerId === undefined ? stored.ownerId : input.ownerId;
  if (!ownerId) return null;
  const projectId = input.projectId ?? stored.projectId;
  return ownerId === stored.ownerId && projectId === stored.projectId
    ? null
    : ownerId;
}
