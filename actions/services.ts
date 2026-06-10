"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import type { ProjectWithServers } from "@/lib/db/schema";
import { loadProjectWithServers } from "@/lib/projects";
import {
  buildStatusCommand,
  getServiceConfig,
  parseServiceState,
  type ServiceAction,
  type ServiceRole,
  type ServiceState,
} from "@/lib/services";
import { executeRemoteCommand } from "@/lib/ssh";
import { createTask } from "@/lib/task-progress";
import {
  projectIdSchema,
  serviceActionSchema,
  serviceRoleSchema,
} from "@/lib/validation";

export type ServiceStatusResult = {
  role: ServiceRole;
  state: ServiceState;
  raw: string;
  error?: string;
};

// Internal: probe one service against an already-loaded (trusted) project.
async function probeServiceStatus(
  project: ProjectWithServers,
  role: ServiceRole
): Promise<ServiceStatusResult> {
  const cfg = getServiceConfig(project, role);
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

export async function getServiceStatus(
  projectId: string,
  role: ServiceRole
): Promise<ServiceStatusResult> {
  await requireSession();
  const parsedRole = serviceRoleSchema.safeParse(role);
  if (!projectIdSchema.safeParse(projectId).success || !parsedRole.success) {
    return { role, state: "unknown", raw: "", error: "Invalid request" };
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) {
    return { role, state: "unknown", raw: "", error: "Project not found" };
  }
  return probeServiceStatus(project, parsedRole.data);
}

// Probe all three services in parallel — each runs against its own server's
// SSH credentials, so there's no cross-server interference.
export async function getAllServiceStatuses(
  projectId: string
): Promise<ServiceStatusResult[]> {
  await requireSession();
  if (!projectIdSchema.safeParse(projectId).success) {
    return [];
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) return [];
  return Promise.all([
    probeServiceStatus(project, "db"),
    probeServiceStatus(project, "backend"),
    probeServiceStatus(project, "frontend"),
  ]);
}

export async function controlService(
  projectId: string,
  role: ServiceRole,
  action: ServiceAction
): Promise<{ taskId: string }> {
  const session = await requireSession();
  const parsedRole = serviceRoleSchema.safeParse(role);
  const parsedAction = serviceActionSchema.safeParse(action);
  if (
    !projectIdSchema.safeParse(projectId).success ||
    !parsedRole.success ||
    !parsedAction.success
  ) {
    throw new Error("Invalid request");
  }
  const project = await loadProjectWithServers(projectId);
  if (!project) throw new Error("Project not found");

  const cfg = getServiceConfig(project, parsedRole.data);
  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `${actionLabel(parsedAction.data)} ${parsedRole.data} service (${cfg.serviceName})`,
  });
  await inngest.send({
    name: "service/control.requested",
    data: {
      projectId: project.id,
      role: parsedRole.data,
      action: parsedAction.data,
      taskId,
    },
  });
  return { taskId };
}

function actionLabel(action: ServiceAction): string {
  if (action === "start") return "Start";
  if (action === "stop") return "Stop";
  return "Restart";
}
