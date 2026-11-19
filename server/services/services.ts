import {
  type AccessScope,
  accessScopeFromSession,
  requireProjectPermissionIn,
  scopeGrantRole,
} from "@/lib/access-scope";
import { orgGrantRole, requireAnyProjectPermission } from "@/lib/authz";
import type { EnvironmentWithServers } from "@/lib/db/schema";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { enqueue } from "@/lib/queue";
import {
  buildLogsCommand,
  buildStatusCommand,
  getServiceConfig,
  hasService,
  parseServiceState,
  type ServiceAction,
  type ServiceRole,
  type ServiceState,
} from "@/lib/services";
import { executeRemoteCommand } from "@/lib/ssh";
import { sshTarget } from "@/lib/ssh-connect";
import {
  serviceActionSchema,
  serviceRoleSchema,
  uuidSchema,
} from "@/lib/validation";
import { requireSharedDbServiceAccess } from "@/server/services/database-hosts";
import { createRunOrRefuse } from "@/server/services/teardown-runs";

export type ServiceStatusResult = {
  role: ServiceRole;
  state: ServiceState;
  raw: string;
  error?: string;
};

// Internal: probe one service against an already-loaded (trusted) environment.
async function probeServiceStatus(
  environment: EnvironmentWithServers,
  role: ServiceRole
): Promise<ServiceStatusResult> {
  const cfg = getServiceConfig(environment, role);
  try {
    const output = await executeRemoteCommand(
      sshTarget(cfg.server),
      buildStatusCommand(cfg.serviceType, cfg.serviceName)
    );
    return {
      role,
      state: parseServiceState(cfg.serviceType, output),
      raw: output.trim(),
    };
  } catch (error) {
    console.error(`Service status probe failed (${role}):`, error);
    return {
      role,
      state: "unknown",
      raw: "",
      error: "Status check failed",
    };
  }
}

// Probe every service the environment has in parallel — each runs against its own server's
// SSH credentials, so there's no cross-server interference.
export async function getAllServiceStatuses(
  environmentId: string
): Promise<ServiceStatusResult[]> {
  return getAllServiceStatusesFor(
    await accessScopeFromSession(),
    environmentId
  );
}

// getAllServiceStatuses for an explicit scope: the live probes run only after
// the permission passed.
export async function getAllServiceStatusesFor(
  scope: AccessScope,
  environmentId: string
): Promise<ServiceStatusResult[]> {
  await requireProjectPermissionIn(
    scope,
    { environmentId },
    { project: ["read"] }
  );
  if (!uuidSchema.safeParse(environmentId).success) {
    return [];
  }
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) return [];
  const roles = (["db", "backend", "frontend"] as const).filter((role) =>
    hasService(environment, role)
  );
  return Promise.all(
    roles.map((role) => probeServiceStatus(environment, role))
  );
}

export type ServiceLogsResult =
  | { found: false }
  | { found: true; output: string };

const LOGS_TIMEOUT_MS = 20_000;

// A non-follow tail of one service's logs for an explicit scope: the Logs
// page's permission (service:logs on the environment) and its shared
// database container rule, then the same command as the stream without
// `--follow`. The output is raw; callers filter it.
export async function getServiceLogsFor(
  scope: AccessScope,
  environmentId: string,
  role: ServiceRole,
  options: { lines: number; sinceSeconds?: number }
): Promise<ServiceLogsResult> {
  await requireProjectPermissionIn(
    scope,
    { environmentId },
    { service: ["logs"] }
  );
  if (!uuidSchema.safeParse(environmentId).success) return { found: false };
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment || !hasService(environment, role)) return { found: false };
  await requireSharedDbServiceAccess(environment, scopeGrantRole(scope), role);
  const cfg = getServiceConfig(environment, role);
  const output = await executeRemoteCommand(
    sshTarget(cfg.server),
    buildLogsCommand(
      cfg.serviceType,
      cfg.serviceName,
      options.lines,
      cfg.server,
      { follow: false, sinceSeconds: options.sinceSeconds }
    ),
    // In sudo-password mode the command embeds the password: kept out of a
    // failure's logged output.
    {
      timeoutMs: LOGS_TIMEOUT_MS,
      secrets: cfg.server.password ? [cfg.server.password] : [],
    }
  );
  return { found: true, output };
}

export async function controlService(
  environmentId: string,
  role: ServiceRole,
  action: ServiceAction
): Promise<{ runId: string }> {
  // Restart is open to QA (service:restart); start and stop need service:control,
  // which also covers restart.
  const { session } = await requireAnyProjectPermission(
    { environmentId },
    action === "restart"
      ? [{ service: ["restart"] }, { service: ["control"] }]
      : [{ service: ["control"] }]
  );
  const parsedRole = serviceRoleSchema.safeParse(role);
  const parsedAction = serviceActionSchema.safeParse(action);
  if (
    !uuidSchema.safeParse(environmentId).success ||
    !parsedRole.success ||
    !parsedAction.success
  ) {
    throw new Error("Invalid request");
  }
  const environment = await loadEnvironmentWithServers(environmentId);
  if (!environment) throw new Error("Environment not found");

  if (!hasService(environment, parsedRole.data)) {
    throw new Error(`Environment has no ${parsedRole.data} service`);
  }
  await requireSharedDbServiceAccess(
    environment,
    orgGrantRole(session),
    parsedRole.data
  );
  const cfg = getServiceConfig(environment, parsedRole.data);
  const runId = await createRunOrRefuse({
    environmentId: environment.id,
    userId: session.user.id,
    description: `${actionLabel(parsedAction.data)} ${parsedRole.data} service (${cfg.serviceName})`,
  });
  await enqueue("service/control.requested", {
    environmentId: environment.id,
    role: parsedRole.data,
    action: parsedAction.data,
    runId,
  });
  return { runId };
}

function actionLabel(action: ServiceAction): string {
  if (action === "start") return "Start";
  if (action === "stop") return "Stop";
  return "Restart";
}
