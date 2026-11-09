import { posix } from "node:path";
import { z } from "zod";
import type { TeardownRefusal } from "@/lib/teardown/errors";
import {
  loadTeardownEnvironment,
  type TeardownEnvironment,
} from "@/lib/teardown/repository";

type DirParams = { serverId: string; deployDir: string };

export type TeardownStepSpec =
  | { kind: "check_stack"; params: DirParams }
  | { kind: "archive_database"; params: { serviceId: string } }
  | { kind: "archive_deploy_dir"; params: DirParams }
  | { kind: "stack_down"; params: DirParams }
  | { kind: "drop_database"; params: { serviceId: string } }
  | {
      kind: "remove_tunnel_route";
      params: { remoteTunnelId: string; hostname: string };
    }
  | { kind: "remove_access_app"; params: { zoneId: string; appId: string } }
  | { kind: "remove_dns_record"; params: { zoneId: string; recordId: string } }
  | { kind: "remove_deploy_dir"; params: DirParams }
  | { kind: "delete_environment"; params: Record<string, never> };

export type TeardownStepKind = TeardownStepSpec["kind"];

// One path segment: no `.`/`..`, whitespace, quotes or shell metacharacters.
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

// System trees: neither they nor anything under them is ever a deploy dir.
const SYSTEM_TREES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/lib/docker",
  "/var/lib/containers",
];

// Parents of real data: refused themselves, their subdirectories are fine.
const PARENT_DIRS = new Set(["/root", "/opt/stacks", "/srv", "/var/lib"]);

/**
 * The canonical form used for every comparison: `.`/`..`/`//` resolved
 * (`path.posix.normalize`), no trailing slash; `/` stays `/`.
 */
export function normaliseDeployDir(dir: string): string {
  const normal = posix.normalize(dir);
  return normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
}

/**
 * Whether a deploy directory may be archived, brought down and `rm -rf`-ed:
 * absolute, at least two plain segments (so neither `/` nor a top-level dir
 * such as `/deployments`), no `.`/`..` or empty segment, nothing a shell
 * would read (whitespace, quotes, `$`, `;`, `*`, …), not in or under a system
 * tree (`/etc`, `/usr`, `/var/lib/docker`, …) and not itself a parent of real
 * data (`/root`, `/home/<user>`, `/opt/stacks`, `/srv`, `/var/lib`). A
 * trailing slash is fine.
 */
export function isSafeDeployDir(dir: string): boolean {
  if (!dir.startsWith("/")) return false;
  const segments = dir.replace(/\/+$/, "").slice(1).split("/");
  if (segments.length < 2) return false;
  const plain = segments.every(
    (segment) =>
      segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment)
  );
  if (!plain) return false;
  const normal = `/${segments.join("/")}`;
  if (SYSTEM_TREES.some((tree) => dirsOverlap(normal, tree))) return false;
  if (PARENT_DIRS.has(normal)) return false;
  return !(segments.length === 2 && segments[0] === "home");
}

/**
 * The project name plain `docker compose` (no `-p`, no `name:`) derives from
 * a directory: its basename, lowercased, keeping only `[a-z0-9_-]`, without
 * leading `_`/`-` (compose-go's NormalizeProjectName).
 */
export function composeProjectName(dir: string): string {
  return (
    posix
      .basename(normaliseDeployDir(dir))
      .toLowerCase()
      .match(/[a-z0-9_-]/g) ?? []
  )
    .join("")
    .replace(/^[_-]+/, "");
}

/** The machine a server row points at, for comparing rows. */
export function normaliseHost(host: string): string {
  return host.trim().toLowerCase();
}

const dirParams = z.object({
  serverId: z.string().min(1),
  deployDir: z.string().refine(isSafeDeployDir),
});
const serviceParams = z.object({ serviceId: z.string().min(1) });

/**
 * Parses a stored step back into a spec. Params live in a jsonb column and end
 * up in shell commands, so the job re-validates them (the deploy dir too).
 */
export const teardownStepSpecSchema: z.ZodType<TeardownStepSpec> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("check_stack"), params: dirParams }),
    z.object({ kind: z.literal("archive_database"), params: serviceParams }),
    z.object({ kind: z.literal("archive_deploy_dir"), params: dirParams }),
    z.object({ kind: z.literal("stack_down"), params: dirParams }),
    z.object({ kind: z.literal("drop_database"), params: serviceParams }),
    z.object({
      kind: z.literal("remove_tunnel_route"),
      params: z.object({
        remoteTunnelId: z.string().min(1),
        hostname: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("remove_access_app"),
      params: z.object({
        zoneId: z.string().min(1),
        appId: z.string().min(1),
      }),
    }),
    z.object({
      kind: z.literal("remove_dns_record"),
      params: z.object({
        zoneId: z.string().min(1),
        recordId: z.string().min(1),
      }),
    }),
    z.object({ kind: z.literal("remove_deploy_dir"), params: dirParams }),
    z.object({
      kind: z.literal("delete_environment"),
      params: z.object({}).strict(),
    }),
  ]) as z.ZodType<TeardownStepSpec>;

export type TeardownPlan =
  | { steps: TeardownStepSpec[] }
  | { refusal: TeardownRefusal };

/** Whether `child` lies strictly inside `parent` (canonical dirs). */
function isInside(child: string, parent: string): boolean {
  return parent === "/"
    ? child !== "/" && child.startsWith("/")
    : child.startsWith(`${parent}/`);
}

/**
 * Whether one directory is the other or lies inside it (canonical dirs).
 * `/` is the ancestor of every absolute dir.
 */
export function dirsOverlap(a: string, b: string): boolean {
  return a === b || isInside(a, b) || isInside(b, a);
}

/**
 * Whether another environment's dir collides with ours on one machine: the
 * dirs overlap, or plain `docker compose` would give both the same project
 * (so `compose down --remove-orphans --volumes` in ours hits theirs).
 */
export function dirsCollide(ours: string, theirs: string): boolean {
  if (dirsOverlap(ours, theirs)) return true;
  const project = composeProjectName(ours);
  return project !== "" && project === composeProjectName(theirs);
}

/**
 * The ordered steps that delete an environment: check each stack, archive
 * every database and deploy directory, bring the stacks down, drop shared
 * databases, remove the Cloudflare objects the Panel created (only those whose
 * ids are recorded), remove the deploy directories, then the environment row.
 * Nothing destructive comes before both archives. Refuses an unsafe deploy
 * dir, a dir that collides with another environment's on the same machine
 * (compared by host, so two server rows for one machine count as one), a
 * database the Panel cannot dump (only Postgres is), and a Cloudflare object
 * another environment also records. Pure.
 */
export function planTeardown(env: TeardownEnvironment): TeardownPlan {
  const dirs: DirParams[] = [];
  const machineDirs: { host: string; deployDir: string }[] = [];
  const seen = new Set<string>();
  for (const target of env.targets) {
    if (!isSafeDeployDir(target.deployDir)) {
      return { refusal: "unsafeDeployDir" };
    }
    const deployDir = normaliseDeployDir(target.deployDir);
    machineDirs.push({ host: normaliseHost(target.host), deployDir });
    const key = JSON.stringify([target.serverId, deployDir]);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({ serverId: target.serverId, deployDir });
  }

  const shared = machineDirs.some((ours) =>
    env.otherTargets.some(
      (other) =>
        normaliseHost(other.host) === ours.host &&
        dirsCollide(ours.deployDir, normaliseDeployDir(other.deployDir))
    )
  );
  if (shared) return { refusal: "deployDirShared" };

  if (env.dbServices.some((service) => service.dbType !== "postgres")) {
    return { refusal: "databaseBackupUnsupported" };
  }

  const domain = env.domain?.kind === "tunnel" ? env.domain : null;
  const domainShared =
    domain !== null &&
    env.otherDomains.some(
      (other) =>
        (domain.accessAppId !== null &&
          other.accessAppId === domain.accessAppId) ||
        (domain.dnsRecordId !== null &&
          other.dnsRecordId === domain.dnsRecordId)
    );
  if (domainShared) return { refusal: "domainShared" };

  const steps: TeardownStepSpec[] = [];
  for (const params of dirs) steps.push({ kind: "check_stack", params });
  for (const service of env.dbServices) {
    steps.push({ kind: "archive_database", params: { serviceId: service.id } });
  }
  for (const params of dirs) steps.push({ kind: "archive_deploy_dir", params });
  for (const params of dirs) steps.push({ kind: "stack_down", params });
  // In-stack databases went with their stack; only a shared host keeps one.
  for (const service of env.dbServices) {
    if (service.dbKind !== "shared") continue;
    steps.push({ kind: "drop_database", params: { serviceId: service.id } });
  }

  // DNS record, then route, then Access app: at every step in between the
  // hostname either does not resolve or is still behind Access.
  if (domain?.zoneId && domain.dnsRecordId) {
    steps.push({
      kind: "remove_dns_record",
      params: { zoneId: domain.zoneId, recordId: domain.dnsRecordId },
    });
  }
  if (domain?.remoteTunnelId) {
    steps.push({
      kind: "remove_tunnel_route",
      params: {
        remoteTunnelId: domain.remoteTunnelId,
        hostname: domain.hostname,
      },
    });
  }
  if (domain?.zoneId && domain.accessAppId) {
    steps.push({
      kind: "remove_access_app",
      params: { zoneId: domain.zoneId, appId: domain.accessAppId },
    });
  }

  for (const params of dirs) steps.push({ kind: "remove_deploy_dir", params });
  steps.push({ kind: "delete_environment", params: {} });
  return { steps };
}

/** The teardown plan of an environment, or null when it does not exist. */
export async function buildTeardownPlan(
  environmentId: string
): Promise<TeardownPlan | null> {
  const env = await loadTeardownEnvironment(environmentId);
  return env ? planTeardown(env) : null;
}
