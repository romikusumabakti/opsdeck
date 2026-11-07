import { parse } from "yaml";

/**
 * What a repository offers the setup wizard: its compose file and runtime
 * services, and the Dockerfiles a build could use. Pure: the caller reads the
 * files (server/services/setup-detect).
 */

export type DetectedService = {
  name: string;
  image: string | null;
  build: string | null;
  ports: { host: string | null; container: number }[];
  profiles: string[];
};

export type RepoDetectionIssue =
  | "no_compose"
  | "no_dockerfile"
  | "compose_parse_error";

export type RepoDetection = {
  composeFile: string | null;
  /** Runtime services only: those without `profiles` (tools, migrations). */
  services: DetectedService[];
  dockerfiles: string[];
  entryService: string | null;
  entryContainerPort: number | null;
  issues: RepoDetectionIssue[];
};

export const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

const FALLBACK_ENTRY_NAMES = ["frontend", "web", "app"];
const MAX_DOCKERFILE_DEPTH = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPort(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : null;
}

/**
 * One `ports` entry: "80", "8080:80", "127.0.0.1:8091:80/tcp", a number, or
 * the long form. Ranges and container ports that are not a plain number are
 * skipped. The host part stays a string (it may be a ${VAR:-8080} reference).
 */
function parsePort(
  entry: unknown
): { host: string | null; container: number } | null {
  if (isRecord(entry)) {
    const container = asPort(entry.target);
    if (container === null) return null;
    const published = entry.published;
    return {
      host:
        typeof published === "string" || typeof published === "number"
          ? String(published)
          : null,
      container,
    };
  }
  if (typeof entry === "number") {
    const container = asPort(entry);
    return container === null ? null : { host: null, container };
  }
  if (typeof entry !== "string") return null;
  // Colons inside ${VAR:-default} are not separators.
  const masked = entry
    .replace(/\/(tcp|udp|sctp)$/i, "")
    .replace(/\$\{[^}]*\}/g, (m) => m.replaceAll(":", "\u0000"));
  const parts = masked.split(":");
  const container = asPort(parts.at(-1));
  if (container === null) return null;
  const host = parts.length >= 2 ? (parts.at(-2) ?? "") : "";
  return {
    host: host === "" ? null : host.replaceAll("\u0000", ":"),
    container,
  };
}

function parseService(name: string, raw: unknown): DetectedService | null {
  if (!isRecord(raw)) return null;
  const build = raw.build;
  return {
    name,
    image: typeof raw.image === "string" ? raw.image : null,
    build:
      typeof build === "string"
        ? build
        : isRecord(build) && typeof build.context === "string"
          ? build.context
          : null,
    ports: (Array.isArray(raw.ports) ? raw.ports : []).flatMap((p) => {
      const port = parsePort(p);
      return port ? [port] : [];
    }),
    profiles: Array.isArray(raw.profiles)
      ? raw.profiles.filter((p): p is string => typeof p === "string")
      : [],
  };
}

function isDockerfile(path: string): boolean {
  const segments = path.split("/");
  if (segments.length > MAX_DOCKERFILE_DEPTH) return false;
  const base = segments.at(-1) ?? "";
  return base === "Dockerfile" || base.endsWith(".Dockerfile");
}

export function detectRepo(
  files: { path: string; content?: string }[]
): RepoDetection {
  const issues: RepoDetectionIssue[] = [];
  const dockerfiles = files.map((f) => f.path).filter(isDockerfile);
  if (dockerfiles.length === 0) issues.push("no_dockerfile");

  const compose = COMPOSE_FILE_NAMES.map((name) =>
    files.find((f) => f.path === name)
  ).find((f) => f !== undefined);
  const result: RepoDetection = {
    composeFile: compose?.path ?? null,
    services: [],
    dockerfiles,
    entryService: null,
    entryContainerPort: null,
    issues,
  };
  if (!compose) {
    issues.unshift("no_compose");
    return result;
  }

  let services: DetectedService[] = [];
  try {
    const doc: unknown = parse(compose.content ?? "");
    if (!(isRecord(doc) && isRecord(doc.services))) {
      throw new Error("no services map");
    }
    services = Object.entries(doc.services).flatMap(([name, raw]) => {
      const service = parseService(name, raw);
      return service ? [service] : [];
    });
  } catch {
    issues.unshift("compose_parse_error");
    return result;
  }

  result.services = services.filter((s) => s.profiles.length === 0);
  const entry =
    result.services.find((s) => s.ports.length > 0) ??
    result.services.find((s) => FALLBACK_ENTRY_NAMES.includes(s.name));
  result.entryService = entry?.name ?? null;
  result.entryContainerPort = entry?.ports[0]?.container ?? null;
  return result;
}
