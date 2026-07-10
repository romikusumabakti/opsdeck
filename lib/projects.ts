import "server-only";

import { db } from "@/lib/db";
import type {
  EnvironmentWithServers,
  SafeEnvironmentWithServers,
  SafeServer,
  Server,
} from "@/lib/db/schema";

/**
 * Load an environment (deployment) together with its three server relations —
 * including SSH/DB credentials. SERVER-ONLY: the result carries plaintext
 * passwords and the mock-time API key, so it must never be returned to a client
 * component or a background-job payload. Actions take an id from the client
 * (route param `[projectId]`, historically the deployment id) and call this to
 * re-resolve the trusted record server-side; never trust an object sent up from
 * the browser.
 */
export async function loadEnvironmentWithServers(
  id: string
): Promise<EnvironmentWithServers | null> {
  const project = await db.query.environments.findFirst({
    where: { id },
    with: {
      dbServer: true,
      backendServer: true,
      frontendServer: true,
    },
  });
  return (project as EnvironmentWithServers | undefined) ?? null;
}

function stripServer(server: Server): SafeServer {
  const { password: _password, ...safe } = server;
  return safe;
}

/**
 * Drop every secret from a fully-loaded project so the result is safe to send
 * to a client component (and thus serialize into the RSC payload). Strips the
 * three SSH passwords, the mssql `sa` password, and the mock-time API key.
 */
export function sanitizeProject(
  project: EnvironmentWithServers
): SafeEnvironmentWithServers {
  const {
    dbPassword: _dbPassword,
    backendMockTimeApiKey: _apiKey,
    dbServer,
    backendServer,
    frontendServer,
    ...rest
  } = project;
  return {
    ...rest,
    dbServer: stripServer(dbServer),
    backendServer: stripServer(backendServer),
    frontendServer: stripServer(frontendServer),
    hasDbPassword: Boolean(project.dbPassword),
    hasMockTimeApiKey: Boolean(project.backendMockTimeApiKey),
  };
}

/** Load a project and sanitize it in one step for handing to the client. */
export async function loadSafeProject(
  id: string
): Promise<SafeEnvironmentWithServers | null> {
  const project = await loadEnvironmentWithServers(id);
  return project ? sanitizeProject(project) : null;
}
