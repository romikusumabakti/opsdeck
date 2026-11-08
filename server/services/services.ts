import {
  requireAnyProjectPermission,
  requireProjectPermission,
} from "@/lib/authz";
import type { EnvironmentWithServers } from "@/lib/db/schema";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { enqueue } from "@/lib/queue";
import { createRun } from "@/lib/run-progress";
import {
  buildStatusCommand,
  getServiceConfig,
  hasService,
  parseServiceState,
  type ServiceAction,
  type ServiceRole,
  type ServiceState,
} from "@/lib/services";
import { executeRemoteCommand } from "@/lib/ssh";
import {
  serviceActionSchema,
  serviceRoleSchema,
  uuidSchema,
} from "@/lib/validation";
import { requireSharedDbServiceAccess } from "@/server/services/database-hosts";

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
      {
        host: cfg.server.host,
        username: cfg.server.username,
        password: cfg.server.password,
      },
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
  await requireProjectPermission({ environmentId }, { project: ["read"] });
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
    session.user.role,
    parsedRole.data
  );
  const cfg = getServiceConfig(environment, parsedRole.data);
  const runId = await createRun({
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
