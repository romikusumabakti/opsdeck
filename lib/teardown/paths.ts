import { posix } from "node:path";

// Path and name rules shared by the teardown plan, its repository and the
// server steps. A leaf module: it imports nothing from lib/teardown.

// One path segment: no `.`/`..`, whitespace, quotes or shell metacharacters.
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

// System trees: neither they nor anything under them is ever a deploy dir.
export const SYSTEM_TREES = [
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
export const PARENT_DIRS = new Set([
  "/root",
  "/opt/stacks",
  "/srv",
  "/var/lib",
]);

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

/** Whether `child` lies strictly inside `parent` (canonical dirs). */
function isInside(child: string, parent: string): boolean {
  return parent === "/"
    ? child !== "/" && child.startsWith("/")
    : child.startsWith(`${parent}/`);
}

/** Whether `child` is `parent` or lies inside it (canonical dirs). */
export function dirWithin(child: string, parent: string): boolean {
  return child === parent || isInside(child, parent);
}

/**
 * Whether one directory is the other or lies inside it (canonical dirs).
 * `/` is the ancestor of every absolute dir.
 */
export function dirsOverlap(a: string, b: string): boolean {
  return dirWithin(a, b) || isInside(b, a);
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
