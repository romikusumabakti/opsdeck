import "server-only";

import { db } from "@/lib/db";
import type {
  EnvironmentWithServers,
  SafeEnvironmentWithServers,
  SafeServer,
  SafeServiceWithServer,
  Server,
  ServiceWithServer,
} from "@/lib/db/schema";
import { decryptNullable, decryptSecret } from "@/lib/secrets";

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
  const project = await db.query.environments.findFirst({
    where: { id },
    with: {
      services: {
        with: { server: true },
      },
    },
  });
  if (!project) return null;
  // SINGLE decryption boundary for environment credentials: secrets are stored
  // encrypted at rest (lib/secrets) and handed to trusted server-side callers
  // (SSH/DB ops, mock-time) as plaintext here. Every consumer loads through this
  // function, so nothing downstream deals with ciphertext.
  const env = project as EnvironmentWithServers;
  return {
    ...env,
    services: env.services.map(decryptService),
  };
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
  const {
    dbPassword,
    mockTimeApiKey,
    server,
    ...rest
  } = service;
  return {
    ...rest,
    server: stripServer(server),
    hasDbPassword: Boolean(dbPassword),
    hasMockTimeApiKey: Boolean(mockTimeApiKey),
  };
}

/**
 * Drop every secret from a fully-loaded project so the result is safe to send
 * to a client component (and thus serialize into the RSC payload). Strips each
 * service's SSH password, the mssql `sa` password, and the mock-time API key.
 */
export function sanitizeProject(
  project: EnvironmentWithServers
): SafeEnvironmentWithServers {
  return {
    ...project,
    services: project.services.map(stripService),
  };
}

/** Load a project and sanitize it in one step for handing to the client. */
export async function loadSafeProject(
  id: string
): Promise<SafeEnvironmentWithServers | null> {
  const project = await loadEnvironmentWithServers(id);
  return project ? sanitizeProject(project) : null;
}
