"use server";

import { inngest } from "@/inngest/client";
import { requireSession } from "@/lib/auth-session";
import type { ProjectWithServers } from "@/lib/db/schema";
import {
  buildLogsCommand,
  buildStatusCommand,
  getServiceConfig,
  LOG_LINE_OPTIONS,
  parseServiceState,
  type ServiceAction,
  type ServiceRole,
  type ServiceState,
} from "@/lib/services";
import { executeRemoteCommand } from "@/lib/ssh";
import { createTask } from "@/lib/task-progress";

export type ServiceStatusResult = {
  role: ServiceRole;
  state: ServiceState;
  raw: string;
  error?: string;
};

export async function getServiceStatus(
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
    return {
      role,
      state: "unknown",
      raw: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Probe all three services in parallel — each runs against its own server's
// SSH credentials, so there's no cross-server interference.
export async function getAllServiceStatuses(
  project: ProjectWithServers
): Promise<ServiceStatusResult[]> {
  return Promise.all([
    getServiceStatus(project, "db"),
    getServiceStatus(project, "backend"),
    getServiceStatus(project, "frontend"),
  ]);
}

export async function controlService(
  project: ProjectWithServers,
  role: ServiceRole,
  action: ServiceAction
): Promise<{ taskId: string }> {
  const session = await requireSession();
  const cfg = getServiceConfig(project, role);
  const taskId = await createTask({
    projectId: project.id,
    userId: session.user.id,
    description: `${actionLabel(action)} ${role} service (${cfg.serviceName})`,
  });
  await inngest.send({
    name: "service/control.requested",
    data: { project, role, action, taskId },
  });
  return { taskId };
}

function actionLabel(action: ServiceAction): string {
  if (action === "start") return "Start";
  if (action === "stop") return "Stop";
  return "Restart";
}

export type ServiceLogsResult = {
  role: ServiceRole;
  lines: number;
  output: string;
  fetchedAt: string;
};

export async function getServiceLogs(
  project: ProjectWithServers,
  role: ServiceRole,
  lines: number
): Promise<ServiceLogsResult> {
  await requireSession();
  const allowed: number = LOG_LINE_OPTIONS.includes(lines as never)
    ? lines
    : LOG_LINE_OPTIONS[1];
  const cfg = getServiceConfig(project, role);
  const output = await executeRemoteCommand(
    {
      host: cfg.server.host,
      username: cfg.server.username,
      password: cfg.server.password,
    },
    buildLogsCommand(
      cfg.serviceType,
      cfg.serviceName,
      allowed,
      cfg.server.password
    )
  );
  return {
    role,
    lines: allowed,
    output: output.trimEnd(),
    fetchedAt: new Date().toISOString(),
  };
}
