import { shq } from "@/lib/sh";

// Facts gathered from a server by the preflight scan; stored in
// servers.preflight. Non-secret by construction.
export type ServerPreflight = {
  runtime: {
    docker: string | null;
    compose: string | null;
    podman: string | null;
  };
  registry: { url: string; ok: boolean; status: number | null } | null;
  disk: { mount: string; freeBytes: number; totalBytes: number }[];
  cloudflared: { systemd: boolean; containers: string[] };
  listeningPorts: number[];
  publishedPorts: number[];
  postgresCandidates: { container: string; image: string }[];
};

const MARK = "@@";

/**
 * One POSIX `sh` script that gathers every fact. Each probe is fenced by a
 * `@@<name>` marker line and tolerates a missing tool, so a host without
 * podman (or without docker) still yields a complete scan.
 */
export function buildPreflightCommand(registry: string | null): string {
  const lines = [
    `echo ${MARK}docker`,
    "docker version --format '{{.Server.Version}}' 2>/dev/null || true",
    `echo ${MARK}compose`,
    "docker compose version --short 2>/dev/null || true",
    `echo ${MARK}podman`,
    "podman version --format '{{.Version}}' 2>/dev/null || true",
  ];
  if (registry) {
    // https first; plain-HTTP registries answer 000 there, so retry over http.
    const probe = (scheme: "https" | "http") =>
      `s=$(curl -s -o /dev/null -m 5 -w '%{http_code}' ${shq(`${scheme}://${registry}/v2/`)} 2>/dev/null || true)`;
    lines.push(
      `echo ${MARK}registry`,
      probe("https"),
      'echo "https $s"',
      'if [ -z "$s" ] || [ "$s" = 000 ]; then',
      `  ${probe("http")}`,
      '  echo "http $s"',
      "fi"
    );
  }
  lines.push(
    `echo ${MARK}df`,
    "df -PB1 / /deployments 2>/dev/null || true",
    `echo ${MARK}cloudflared`,
    "systemctl is-active cloudflared 2>/dev/null || true",
    `echo ${MARK}ps`,
    "docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}' 2>/dev/null || true",
    `echo ${MARK}ss`,
    "ss -Htln 2>/dev/null || true"
  );
  return lines.join("\n");
}

/**
 * HOST-side ports out of a `docker ps` Ports column, e.g.
 * `127.0.0.1:8091->80/tcp, [::]:8100-8102->8100-8102/tcp, 3000/tcp`.
 * Ranges are expanded; bare exposures (no `->`) publish nothing and are skipped.
 */
export function parseHostPublishedPorts(ports: string): number[] {
  const found = new Set<number>();
  for (const part of ports.split(",")) {
    const match = /(?:^|:)(\d+)(?:-(\d+))?->/.exec(part.trim());
    if (!match) continue;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    // Guard against absurd ranges; a real mapping is far smaller.
    for (let p = from; p <= to && p - from < 65536; p++) found.add(p);
  }
  return [...found].sort((a, b) => a - b);
}

function sections(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(MARK)) {
      current = [];
      result.set(line.slice(MARK.length).trim(), current);
    } else if (current && line.trim() !== "") {
      current.push(line);
    }
  }
  return result;
}

const firstLine = (lines: string[] | undefined): string | null =>
  lines?.[0]?.trim() || null;

// "registry:5000/library/postgres:18@sha256:..." -> "postgres"
function imageRepository(image: string): string {
  const name = image.slice(image.lastIndexOf("/") + 1);
  return name.split(/[:@]/)[0] ?? "";
}

function isPostgresImage(image: string): boolean {
  const repo = imageRepository(image);
  return repo === "postgres" || repo.startsWith("postgis");
}

/** Turns the script output into the stored facts; never throws on odd input. */
export function parsePreflight(
  output: string,
  registry: string | null
): ServerPreflight {
  const found = sections(output);

  let registryResult: ServerPreflight["registry"] = null;
  if (registry) {
    // Lines look like "https 000" / "http 200"; the first scheme that got an
    // HTTP answer wins, else report the https URL as unanswered.
    let url = `https://${registry}/v2/`;
    let status: number | null = null;
    for (const line of found.get("registry") ?? []) {
      const [scheme, raw] = line.trim().split(/\s+/);
      const code = Number(raw);
      if ((scheme === "https" || scheme === "http") && code > 0) {
        url = `${scheme}://${registry}/v2/`;
        status = code;
        break;
      }
    }
    // 401 is the registry's auth challenge: it answers, so it is reachable.
    registryResult = { url, ok: status === 200 || status === 401, status };
  }

  const disk: ServerPreflight["disk"] = [];
  for (const line of found.get("df") ?? []) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const totalBytes = Number(cols[1]);
    const freeBytes = Number(cols[3]);
    const mount = cols[cols.length - 1] ?? "";
    // The header row has no numeric size columns.
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) continue;
    if (disk.some((d) => d.mount === mount)) continue;
    disk.push({ mount, freeBytes, totalBytes });
  }

  const containers = (found.get("ps") ?? []).map((line) => {
    const [container = "", image = "", ports = ""] = line.split("\t");
    return { container, image, ports };
  });

  const listening = new Set<number>();
  for (const line of found.get("ss") ?? []) {
    const local = line.trim().split(/\s+/)[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) listening.add(port);
  }

  const published = new Set<number>();
  for (const c of containers) {
    for (const p of parseHostPublishedPorts(c.ports)) published.add(p);
  }

  return {
    runtime: {
      docker: firstLine(found.get("docker")),
      compose: firstLine(found.get("compose")),
      podman: firstLine(found.get("podman")),
    },
    registry: registryResult,
    disk,
    cloudflared: {
      systemd: firstLine(found.get("cloudflared")) === "active",
      containers: containers
        .filter((c) => c.image.includes("cloudflared"))
        .map((c) => c.container),
    },
    listeningPorts: [...listening].sort((a, b) => a - b),
    publishedPorts: [...published].sort((a, b) => a - b),
    postgresCandidates: containers
      .filter((c) => isPostgresImage(c.image))
      .map(({ container, image }) => ({ container, image })),
  };
}
