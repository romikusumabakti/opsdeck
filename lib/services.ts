import type { ProjectWithServers, Server } from "@/lib/db/schema";
import { shq } from "@/lib/sh";

export type ServiceRole = "db" | "backend" | "frontend";
export type ServiceAction = "start" | "stop" | "restart";
export type ServiceState = "running" | "stopped" | "not-found" | "unknown";

export type ServiceType = "docker" | "systemd" | "kubernetes";

// Sentinel emitted by the status command when the underlying tool can't find
// the resource (otherwise `docker inspect` / `kubectl get` exits non-zero and
// executeRemoteCommand throws).
const NOT_FOUND_MARKER = "__dss_not_found__";

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
    const inner = `docker container inspect -f '{{.State.Status}}' ${shq(serviceName)} 2>/dev/null || echo ${NOT_FOUND_MARKER}`;
    return `sh -c ${shq(inner)}`;
  }
  if (serviceType === "kubernetes") {
    // Emit "<desired> <ready>" so the parser can distinguish stopped (desired=0),
    // running (ready>=1), and transitioning (desired>0, ready=0). jsonpath
    // prints an empty string when `readyReplicas` is absent (pre-rollout), which
    // we treat as 0 ready.
    const inner = `kubectl get deploy ${shq(serviceName)} -o jsonpath='{.spec.replicas} {.status.readyReplicas}' 2>/dev/null || echo ${NOT_FOUND_MARKER}`;
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
    if (value === NOT_FOUND_MARKER) return "not-found";
    if (value === "running") return "running";
    return "stopped";
  }
  if (serviceType === "kubernetes") {
    if (value === NOT_FOUND_MARKER) return "not-found";
    const [desiredStr, readyStr] = value.split(/\s+/);
    const desired = Number.parseInt(desiredStr ?? "", 10);
    const ready = Number.parseInt(readyStr ?? "", 10);
    if (!Number.isFinite(desired)) return "unknown";
    if (desired === 0) return "stopped";
    if (Number.isFinite(ready) && ready >= 1) return "running";
    return "stopped";
  }
  if (value === "active" || value === "activating") return "running";
  if (value === "inactive" || value === "deactivating") return "stopped";
  if (value === "failed") return "stopped";
  if (value === "unknown") return "not-found";
  return "unknown";
}

// systemctl needs sudo; docker and kubectl don't (the SSH user is assumed to
// be in the docker group / have a working KUBECONFIG, same assumption made by
// the backup/restore commands).
export function buildControlCommand(
  serviceType: ServiceType,
  serviceName: string,
  action: ServiceAction,
  sudoPassword: string
): string {
  if (serviceType === "docker") {
    return `docker ${action} ${shq(serviceName)}`;
  }
  if (serviceType === "kubernetes") {
    // Restart maps to `rollout restart` (preserves replica count). Start/stop
    // map to `scale`: start assumes a single replica (panel scope is dev/test
    // single-instance services), stop scales to 0.
    if (action === "restart") {
      return `kubectl rollout restart deploy ${shq(serviceName)}`;
    }
    const replicas = action === "start" ? 1 : 0;
    return `kubectl scale deploy ${shq(serviceName)} --replicas=${replicas}`;
  }
  // `printf '%s\n' PASSWORD | sudo -S CMD` feeds the password to sudo via
  // stdin so it never appears as an argv (which would be visible in `ps`).
  return `printf '%s\\n' ${shq(sudoPassword)} | sudo -S systemctl ${action} ${shq(serviceName)}`;
}

export const LOG_LINE_OPTIONS = [100, 200, 500, 1000] as const;
export type LogLines = (typeof LOG_LINE_OPTIONS)[number];

// Wraps a shell pipeline `inner` so it runs in the database service's
// execution environment. `docker exec` / `kubectl exec` run the pipeline
// inside the container/pod (so it sees the container's filesystem and the
// container user). `systemd` runs it directly on the SSH host; when
// `runAsUser` is set, the pipeline is invoked via `sudo -S -u <user>` so
// Postgres peer auth and OS-level write permissions (e.g. mssql owning
// /var/opt/mssql/backups) are satisfied without forcing the operator to
// chmod 777 the backup path. `runAsUser` is ignored for docker/kubernetes
// since the exec wrappers already enter the container as its configured user.
//
// Uses `bash -c` rather than `sh -c` because callers rely on `set -o
// pipefail` to catch mid-pipe failures (e.g. pg_dump → gzip). dash, the
// default /bin/sh on Debian/Ubuntu, doesn't support pipefail and would
// error out with "Illegal option -o pipefail". Bash is present by default
// on systemd hosts and in the official postgres/mssql images; if you ship
// a minimal image without it (e.g. postgres:alpine), install bash.
export function buildDbShellCommand(
  serviceType: ServiceType,
  serviceName: string,
  inner: string,
  options: {
    runAsUser?: string;
    sudoPassword?: string;
  } = {}
): string {
  if (serviceType === "docker") {
    return `docker exec ${shq(serviceName)} bash -c ${shq(inner)}`;
  }
  if (serviceType === "kubernetes") {
    return `kubectl exec deploy/${shq(serviceName)} -- bash -c ${shq(inner)}`;
  }
  if (options.runAsUser) {
    if (!options.sudoPassword) {
      throw new Error(
        `buildDbShellCommand: sudoPassword is required when runAsUser is set (got runAsUser="${options.runAsUser}")`
      );
    }
    // sudo -S consumes one newline-terminated password from stdin, then
    // execs the inner shell as `runAsUser`. The inner shell manages its own
    // stdin (e.g. `printf QUERY | psql`) — no stdin conflict because the
    // outer printf only emits a single line consumed entirely by sudo.
    return `printf '%s\\n' ${shq(options.sudoPassword)} | sudo -S -u ${shq(options.runAsUser)} bash -c ${shq(inner)}`;
  }
  return `bash -c ${shq(inner)}`;
}

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
  if (serviceType === "kubernetes") {
    // `deploy/<name>` selects one of the deployment's pods. `--timestamps`
    // prefixes each line with an RFC3339 timestamp so the viewer can correlate
    // with other sources.
    const inner = `kubectl logs deploy/${shq(serviceName)} --tail ${lines} --timestamps 2>&1 || true`;
    return `sh -c ${shq(inner)}`;
  }
  // `--no-pager` avoids less/more pagination over SSH. `--output=short-iso`
  // gives a compact UTC-style timestamp that's easy to read in a log viewer.
  const journal = `journalctl -u ${shq(serviceName)} -n ${lines} --no-pager --output=short-iso 2>&1 || true`;
  const inner = `printf '%s\\n' ${shq(sudoPassword)} | sudo -S ${journal}`;
  return `sh -c ${shq(inner)}`;
}
