import { parse } from "yaml";
import { type BuildSpec, buildSpecSchema } from "@/lib/ci/build-spec";
import { PANEL_PIPELINE_MARKER } from "@/lib/ci/pipeline";
import { bundleImageFor } from "@/lib/ci/registration";
import { bundleImageSchema } from "@/lib/deploy/validation";

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
  /** The compose `container_name`, when the service fixes one. */
  containerName: string | null;
};

export type RepoPipeline =
  | { kind: "none" }
  | { kind: "panel"; componentKey: string }
  | { kind: "custom"; notifiesPanel: boolean };

export type RepoDetectionIssue =
  | "no_compose"
  | "no_dockerfile"
  | "compose_parse_error";

export type RepoDetection = {
  composeFile: string | null;
  /** Compose override files next to the compose file, in merge order. */
  composeOverrides: string[];
  /** The compose top-level `name:`, which replaces the directory as project. */
  projectName: string | null;
  /** Runtime services only: those without `profiles` (tools, migrations). */
  services: DetectedService[];
  dockerfiles: string[];
  pipeline: RepoPipeline;
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
    containerName:
      typeof raw.container_name === "string" ? raw.container_name : null,
  };
}

function isDockerfile(path: string): boolean {
  const segments = path.split("/");
  if (segments.length > MAX_DOCKERFILE_DEPTH) return false;
  const base = segments.at(-1) ?? "";
  return base === "Dockerfile" || base.endsWith(".Dockerfile");
}

const WOODPECKER_NAMES = [".woodpecker.yaml", ".woodpecker.yml"];

function detectPipeline(
  files: { path: string; content?: string }[]
): RepoPipeline {
  const file =
    WOODPECKER_NAMES.map((name) => files.find((f) => f.path === name)).find(
      (f) => f !== undefined
    ) ?? files.find((f) => f.path.startsWith(".woodpecker/"));
  if (!file) return { kind: "none" };
  const content = file.content ?? "";
  const key = PANEL_PIPELINE_MARKER.exec(content)?.[1];
  if (key) return { kind: "panel", componentKey: key };
  return { kind: "custom", notifiesPanel: content.includes("opsdeck_notify") };
}

const COMPOSE_OVERRIDE_NAMES = [
  "compose.override.yaml",
  "compose.override.yml",
  "docker-compose.override.yaml",
  "docker-compose.override.yml",
];

/**
 * A build spec to start from: the root Dockerfile builds image `<key>`, each
 * `<dir>/Dockerfile` builds `<key>-<dir>`, and the compose file (plus its
 * override, when present) goes into the bundle. Null without a Dockerfile or
 * a compose file, or when the result is not a valid spec.
 */
export function suggestedBuildSpec(
  detection: RepoDetection,
  componentKey: string,
  branch: string
): BuildSpec | null {
  if (!detection.composeFile) return null;
  const images = detection.dockerfiles.flatMap((path) => {
    const segments = path.split("/");
    if (segments.length === 1) {
      return path === "Dockerfile"
        ? [{ name: componentKey, dockerfile: path, context: "." }]
        : [];
    }
    const [dir] = segments;
    if (segments.length !== 2 || segments[1] !== "Dockerfile" || !dir) {
      return [];
    }
    // A directory the image-name rule rejects (spaces, ...) is skipped so the
    // other images survive; the deploy bundle's own name is never reused.
    const name = `${componentKey}-${dir.toLowerCase()}`;
    return bundleImageSchema.safeParse(name).success &&
      name !== bundleImageFor(componentKey)
      ? [{ name, dockerfile: path, context: dir }]
      : [];
  });
  if (images.length === 0) return null;
  const bundle = [detection.composeFile, ...detection.composeOverrides];
  const candidate = {
    branches: [branch],
    images,
    bundleFiles: bundle.map((path) => ({ from: path, to: path })),
    checks: [],
    timeoutMinutes: 60,
  };
  const parsed = buildSpecSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
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
    composeOverrides: files
      .map((f) => f.path)
      .filter((path) => COMPOSE_OVERRIDE_NAMES.includes(path)),
    projectName: null,
    services: [],
    dockerfiles,
    pipeline: detectPipeline(files),
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
    result.projectName = typeof doc.name === "string" ? doc.name : null;
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
