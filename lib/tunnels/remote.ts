import "server-only";

import { shq } from "@/lib/sh";
import { executeRemoteCommand } from "@/lib/ssh";

// Everything this feature does on the tunnel's host: reading and replacing the
// config, asking cloudflared to judge it, recreating the container, and the
// Docker lookups the preflight checks need.
//
// The pure editing lives in ./ingress and ./compose; this module only moves
// bytes and runs commands, so the risky part stays unit-testable.

export type SshCreds = { host: string; username: string; password: string };

export class TunnelRemoteError extends Error {}

// `docker compose up -d` recreates a container and waits for it: well past the
// 10s default of executeRemoteCommand, which is tuned for page-render probes.
const APPLY_TIMEOUT_MS = 180_000;
// `docker run … ingress validate` starts a throwaway container.
const VALIDATE_TIMEOUT_MS = 60_000;

/** Absolute path of a tunnel's config.yml on its host. */
export function configFilePath(tunnel: {
  stackDir: string;
  configPath: string;
}): string {
  return `${tunnel.stackDir.replace(/\/$/, "")}/${tunnel.configPath}`;
}

export function composeFilePath(stackDir: string): string {
  return `${stackDir.replace(/\/$/, "")}/compose.yml`;
}

function parentDir(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export async function readRemoteText(
  creds: SshCreds,
  path: string
): Promise<string> {
  return executeRemoteCommand(creds, `cat -- ${shq(path)}`, 15_000);
}

/**
 * Replace a file's contents without ever leaving a partial file in its place.
 *
 * The bytes travel base64-encoded so no shell metacharacter, newline, or quote
 * in a YAML document can influence the command, and land in a sibling temp file
 * that is `mv`'d over the target — a rename within one directory is atomic, so
 * `cloudflared` can never observe a half-written config even if the connection
 * drops mid-transfer.
 *
 * The temp file's permissions and ownership are copied from the target first,
 * because the config is bind-mounted into a container running as uid 65532 and
 * a fresh file created under the SSH user's umask may not be readable by it.
 */
export async function writeRemoteTextAtomically(
  creds: SshCreds,
  path: string,
  content: string,
  options: { keepBackup?: boolean } = {}
): Promise<void> {
  const temp = `${path}.opsdeck-new`;
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const steps = [
    `cp -p -- ${shq(path)} ${shq(temp)}`,
    `printf %s ${shq(encoded)} | base64 -d > ${shq(temp)}`,
  ];
  if (options.keepBackup) {
    steps.push(`cp -p -- ${shq(path)} ${shq(`${path}.bak`)}`);
  }
  steps.push(`mv -- ${shq(temp)} ${shq(path)}`);
  await executeRemoteCommand(creds, steps.join(" && "), 30_000);
}

/**
 * Stage `content` next to `path` without installing it, so cloudflared can
 * validate the candidate before anything live is touched. Returns the staged
 * path; the caller must install it with `commitStagedFile` or drop it with
 * `discardStagedFile`.
 */
export async function stageRemoteText(
  creds: SshCreds,
  path: string,
  content: string
): Promise<string> {
  const temp = `${path}.opsdeck-new`;
  const encoded = Buffer.from(content, "utf8").toString("base64");
  await executeRemoteCommand(
    creds,
    [
      `cp -p -- ${shq(path)} ${shq(temp)}`,
      `printf %s ${shq(encoded)} | base64 -d > ${shq(temp)}`,
    ].join(" && "),
    30_000
  );
  return temp;
}

/** Install a staged file, keeping the replaced version as `<path>.bak`. */
export async function commitStagedFile(
  creds: SshCreds,
  path: string
): Promise<void> {
  const temp = `${path}.opsdeck-new`;
  await executeRemoteCommand(
    creds,
    `cp -p -- ${shq(path)} ${shq(`${path}.bak`)} && mv -- ${shq(temp)} ${shq(path)}`,
    30_000
  );
}

export async function discardStagedFile(
  creds: SshCreds,
  path: string
): Promise<void> {
  await executeRemoteCommand(
    creds,
    `rm -f -- ${shq(`${path}.opsdeck-new`)}`,
    15_000
  );
}

/**
 * Put `<path>.bak` back and return true, or return false when there is no
 * backup to restore. Used when an apply fails: the tunnel must go back to the
 * configuration that was known to work rather than sit on a rejected one.
 */
export async function restoreBackup(
  creds: SshCreds,
  path: string
): Promise<boolean> {
  const output = await executeRemoteCommand(
    creds,
    `if [ -f ${shq(`${path}.bak`)} ]; then cp -p -- ${shq(`${path}.bak`)} ${shq(path)} && echo restored; else echo none; fi`,
    30_000
  );
  return output.trim() === "restored";
}

/**
 * The image the tunnel container is running.
 *
 * Validation runs in a throwaway container of the SAME image, so the binary
 * judging the config is the binary that will load it — a newer `cloudflared`
 * could accept a key the running one rejects, which is the one way this check
 * could give false confidence.
 */
export async function tunnelImage(
  creds: SshCreds,
  containerName: string
): Promise<string> {
  const image = await executeRemoteCommand(
    creds,
    `docker container inspect -f '{{.Config.Image}}' ${shq(containerName)}`,
    15_000
  );
  const trimmed = image.trim();
  if (!trimmed) {
    throw new TunnelRemoteError(
      `Could not determine the image of container ${containerName}`
    );
  }
  return trimmed;
}

/**
 * Run `cloudflared tunnel ingress validate` against a config file on the host.
 *
 * cloudflared is the authority on its own config, so the panel asks it rather
 * than trusting that a document this codebase can parse is a document the
 * daemon will accept. Throws with cloudflared's own output on rejection.
 */
export async function validateIngressFile(
  creds: SshCreds,
  options: { image: string; filePath: string }
): Promise<string> {
  const dir = parentDir(options.filePath);
  const file = baseName(options.filePath);
  try {
    return await executeRemoteCommand(
      creds,
      // `--config` is a flag of the `tunnel` command, not of `ingress
      // validate`: putting it after the subcommand fails with "flag provided
      // but not defined: -config".
      `docker run --rm -v ${shq(`${dir}:/etc/cloudflared:ro`)} ${shq(options.image)} tunnel --config ${shq(`/etc/cloudflared/${file}`)} ingress validate`,
      VALIDATE_TIMEOUT_MS
    );
  } catch (error) {
    throw new TunnelRemoteError(
      `cloudflared rejected the new configuration: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Recreate the tunnel container so it loads the new config.
 *
 * `cloudflared` does not reload config.yml on its own — a locally-managed
 * tunnel reads it once at startup — so an edit that is not followed by this is
 * an edit that has not taken effect.
 */
export async function applyStack(
  creds: SshCreds,
  stackDir: string
): Promise<string> {
  return executeRemoteCommand(
    creds,
    `cd ${shq(stackDir)} && docker compose up -d`,
    APPLY_TIMEOUT_MS
  );
}

/** `docker compose config -q` — syntax check before applying a compose edit. */
export async function validateCompose(
  creds: SshCreds,
  stackDir: string,
  fileName = "compose.yml"
): Promise<void> {
  try {
    await executeRemoteCommand(
      creds,
      `cd ${shq(stackDir)} && docker compose -f ${shq(fileName)} config -q`,
      30_000
    );
  } catch (error) {
    throw new TunnelRemoteError(
      `docker compose rejected the edited file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// A healthy cloudflared holds four connections, one to each of the edge colos
// it is assigned. Used only by the log fallback below.
export const EXPECTED_TUNNEL_CONNECTIONS = 4;

export type TunnelHealth = {
  healthy: boolean;
  // Human-readable evidence, quoted into the failure message so a rollback
  // report says WHY the tunnel was judged unhealthy.
  detail: string;
};

/**
 * Judge whether the tunnel is serving.
 *
 * Asks cloudflared's own readiness probe first — the same command the stack's
 * healthcheck runs — because it reports the CURRENT state. Counting
 * "Registered tunnel connection" in the log cannot: those lines accumulate
 * across every reconnect for the life of the container, so a tunnel that has
 * been up for a month reports 21 registrations while holding four connections.
 *
 * The log count survives as a fallback for configs that don't enable the
 * metrics listener, where the probe has nothing to talk to. It is sound in that
 * role: the only caller that needs it runs right after the container was
 * recreated, so the log starts empty and reaching four means four came up.
 */
export async function probeTunnelHealth(
  creds: SshCreds,
  containerName: string
): Promise<TunnelHealth> {
  const output = await executeRemoteCommand(
    creds,
    `if docker exec ${shq(containerName)} cloudflared tunnel --metrics 127.0.0.1:2000 ready >/dev/null 2>&1; then echo READY; else docker logs ${shq(containerName)} 2>&1 | grep -c 'Registered tunnel connection' || true; fi`,
    25_000
  );
  const result = output.trim();
  if (result === "READY") return { healthy: true, detail: "ready" };
  const registrations = Number.parseInt(result, 10) || 0;
  return {
    healthy: registrations >= EXPECTED_TUNNEL_CONNECTIONS,
    detail: `${registrations}/${EXPECTED_TUNNEL_CONNECTIONS} edge connections registered`,
  };
}

/**
 * Wait for a freshly recreated container to start serving.
 *
 * `docker compose up -d` returns as soon as the container is started, long
 * before cloudflared has decided whether it can serve anything, so an apply
 * that is not followed by this reports success it hasn't earned.
 */
export async function waitForTunnelHealth(
  creds: SshCreds,
  containerName: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<TunnelHealth> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let last: TunnelHealth = { healthy: false, detail: "not probed" };
  while (Date.now() < deadline) {
    last = await probeTunnelHealth(creds, containerName);
    if (last.healthy) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

export type ContainerInfo = {
  name: string;
  state: ContainerState;
  // Real Docker network names, as Docker reports them — NOT the aliases a
  // compose file references them by.
  networks: string[];
  // Container-side ports, e.g. [80, 3000]. Offered as suggestions in the origin
  // picker; a container may serve a port it never declared.
  ports: number[];
};

// One container per line, four tab-delimited groups. Tab-delimited because
// container and network names may contain hyphens, dots and commas, but never
// a tab — a comma separator would be ambiguous against the network list.
const PS_FORMAT = "{{.Names}}\t{{.State}}\t{{.Networks}}\t{{.Ports}}";

/**
 * Containers on the host, for the origin picker.
 *
 * `-a` includes stopped ones: an operator publishing a hostname for an app
 * that is currently down needs to see it in the list and be told why it can't
 * be routed yet, rather than find it simply missing.
 *
 * Origins are addressed by container name over the app's own network rather
 * than by a port published on the host: those published ports are what putting
 * the app behind a tunnel is meant to close, and a route through one stops
 * working the day that happens.
 */
export async function listContainers(
  creds: SshCreds
): Promise<ContainerInfo[]> {
  const output = await executeRemoteCommand(
    creds,
    `docker ps -a --format ${shq(PS_FORMAT)}`,
    20_000
  );
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name = "", state = "", networks = "", ports = ""] =
        line.split("\t");
      return {
        name: name.trim(),
        state:
          state.trim() === "running"
            ? "running"
            : ("stopped" as ContainerState),
        networks: networks
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean),
        ports: parsePublishedPorts(ports),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Container-side port numbers out of a `docker ps` Ports column.
 *
 * The column mixes published mappings (`0.0.0.0:8080->80/tcp`) with bare
 * exposures (`3000/tcp`); both are reported as the port INSIDE the container,
 * since that is what an ingress origin has to address.
 */
export function parsePublishedPorts(ports: string): number[] {
  const found = new Set<number>();
  for (const part of ports.split(",")) {
    const match = /(?:->)?(\d+)\/(?:tcp|udp)/.exec(part.trim());
    if (match) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** Real Docker network names a single container is attached to. */
export async function containerNetworks(
  creds: SshCreds,
  containerName: string
): Promise<string[]> {
  const output = await executeRemoteCommand(
    creds,
    `docker container inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${shq(containerName)}`,
    15_000
  );
  return output.trim().split(/\s+/).filter(Boolean);
}

export type ContainerState = "running" | "stopped" | "not-found";

// Same sentinel technique as lib/services.ts: `docker inspect` exits non-zero
// for an unknown container, which executeRemoteCommand turns into a throw.
const NOT_FOUND_MARKER = "__opsdeck_not_found__";

export async function containerState(
  creds: SshCreds,
  containerName: string
): Promise<ContainerState> {
  const output = await executeRemoteCommand(
    creds,
    `docker container inspect -f '{{.State.Status}}' ${shq(containerName)} 2>/dev/null || echo ${NOT_FOUND_MARKER}`,
    15_000
  );
  const status = output.trim();
  if (status === NOT_FOUND_MARKER || !status) return "not-found";
  return status === "running" ? "running" : "stopped";
}
