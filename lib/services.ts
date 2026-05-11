import type { ProjectWithServers, Server } from "@/lib/db/schema";
import { shq } from "@/lib/sh";

export type ServiceRole = "db" | "backend" | "frontend";
export type ServiceAction = "start" | "stop" | "restart";
export type ServiceState = "running" | "stopped" | "not-found" | "unknown";

export type ServiceType = "docker" | "system";

// Sentinel emitted by the status command when docker can't find the container
// (otherwise `docker inspect` exits non-zero and executeRemoteCommand throws).
const DOCKER_NOT_FOUND_MARKER = "__dss_not_found__";

export type ServiceConfig = {
  role: ServiceRole;
  server: Server;
  serviceType: ServiceType;
  serviceName: string;
};

export function getServiceConfig(
  project: ProjectWithServers,
  role: ServiceRole
): ServiceConfig {
  if (role === "db") {
    return {
      role,
      server: project.dbServer,
      serviceType: project.dbServiceType,
      serviceName: project.dbServiceName,
    };
  }
  if (role === "backend") {
    return {
      role,
      server: project.backendServer,
      serviceType: project.backendServiceType,
      serviceName: project.backendServiceName,
    };
  }
  return {
    role,
    server: project.frontendServer,
    serviceType: project.frontendServiceType,
    serviceName: project.frontendServiceName,
  };
}

// Build a command that always exits 0 so executeRemoteCommand doesn't throw on
// stopped/missing services — we want to surface state via stdout, not errors.
export function buildStatusCommand(
  serviceType: ServiceType,
  serviceName: string
): string {
  if (serviceType === "docker") {
    const inner = `docker container inspect -f '{{.State.Status}}' ${shq(serviceName)} 2>/dev/null || echo ${DOCKER_NOT_FOUND_MARKER}`;
    return `sh -c ${shq(inner)}`;
  }
  // `systemctl is-active` exits non-zero for inactive/failed/unknown, but we
  // still want the stdout value (`inactive`, `failed`, ...) — `|| true` keeps
  // exit at 0 so the SSH wrapper passes the output through.
  const inner = `systemctl is-active ${shq(serviceName)} 2>/dev/null || true`;
  return `sh -c ${shq(inner)}`;
}

export function parseServiceState(
  serviceType: ServiceType,
  output: string
): ServiceState {
  const value = output.trim();
  if (!value) return "unknown";
  if (serviceType === "docker") {
    if (value === DOCKER_NOT_FOUND_MARKER) return "not-found";
    if (value === "running") return "running";
    return "stopped";
  }
  if (value === "active" || value === "activating") return "running";
  if (value === "inactive" || value === "deactivating") return "stopped";
  if (value === "failed") return "stopped";
  if (value === "unknown") return "not-found";
  return "unknown";
}

// systemctl needs sudo; docker doesn't (the SSH user is assumed to be in the
// docker group, same assumption made by the backup/restore commands).
export function buildControlCommand(
  serviceType: ServiceType,
  serviceName: string,
  action: ServiceAction,
  sudoPassword: string
): string {
  if (serviceType === "docker") {
    return `docker ${action} ${shq(serviceName)}`;
  }
  // `printf '%s\n' PASSWORD | sudo -S CMD` feeds the password to sudo via
  // stdin so it never appears as an argv (which would be visible in `ps`).
  return `printf '%s\\n' ${shq(sudoPassword)} | sudo -S systemctl ${action} ${shq(serviceName)}`;
}

export const LOG_LINE_OPTIONS = [100, 200, 500, 1000] as const;
export type LogLines = (typeof LOG_LINE_OPTIONS)[number];

// Docker logs writes to stderr by default, and journalctl may exit non-zero on
// empty units — both reasons we wrap in `sh -c` with `2>&1` and `|| true` so the
// remote command always exits 0 and we get all output on stdout.
export function buildLogsCommand(
  serviceType: ServiceType,
  serviceName: string,
  lines: number,
  sudoPassword: string
): string {
  if (serviceType === "docker") {
    const inner = `docker logs --tail ${lines} --timestamps ${shq(serviceName)} 2>&1 || true`;
    return `sh -c ${shq(inner)}`;
  }
  // `--no-pager` avoids less/more pagination over SSH. `--output=short-iso`
  // gives a compact UTC-style timestamp that's easy to read in a log viewer.
  const journal = `journalctl -u ${shq(serviceName)} -n ${lines} --no-pager --output=short-iso 2>&1 || true`;
  const inner = `printf '%s\\n' ${shq(sudoPassword)} | sudo -S ${journal}`;
  return `sh -c ${shq(inner)}`;
}
