// Where the user is inside the project → environment hierarchy, read from the
// locale-stripped pathname, plus the ordering rules every project/environment
// picker shares. Pure and client-safe: the header switchers, the sidebar and
// the command palette all read the same rules.
// See docs/superpowers/specs/2026-10-09-project-environment-switcher-design.md.

import {
  canProject,
  type ProjectPermissions,
  type ProjectRole,
} from "@/lib/permissions";
import {
  RESERVED_ENV_SLUGS,
  RESERVED_PROJECT_KEYS,
} from "@/lib/reserved-paths";

// Canonical casing only: the proxy 308s /cmem/PROD to /CMEM/prod before render.
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const ENV_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export type ProjectPage =
  | "overview"
  | "settings"
  | "issue"
  | "new-environment"
  | "other";

export type NavPath =
  | {
      scope: "env";
      projectKey: string;
      envSlug: string;
      section: string | null;
      // /KEY/env/services/<role>/logs — a page below Services.
      logs: boolean;
    }
  | { scope: "project"; projectKey: string; page: ProjectPage }
  | { scope: null };

export type NavProject = { id: string; key: string; name: string };

// A project's own sub-routes, keyed by their reserved second segment.
const PROJECT_PAGES: Record<string, ProjectPage> = {
  settings: "settings",
  issues: "issue",
  environments: "new-environment",
};

export function parseNavPath(pathname: string): NavPath {
  const [key, second, third, , fifth] = pathname.split("/").filter(Boolean);
  if (!key || !PROJECT_KEY.test(key) || RESERVED_PROJECT_KEYS.has(key)) {
    return { scope: null };
  }
  if (!second) return { scope: "project", projectKey: key, page: "overview" };
  // Reserved slugs are the project's own routes; an environment can never
  // carry one, so they are checked before the environment reading.
  if (RESERVED_ENV_SLUGS.has(second)) {
    return {
      scope: "project",
      projectKey: key,
      page: PROJECT_PAGES[second] ?? "other",
    };
  }
  if (!ENV_SLUG.test(second)) return { scope: null };
  return {
    scope: "env",
    projectKey: key,
    envSlug: second,
    section: third ?? null,
    logs: third === "services" && fifth === "logs",
  };
}

// Kind decides an environment's position within its project so lists read in
// promotion order (prod last) instead of alphabetically shuffled.
export const KIND_ORDER: Readonly<Record<string, number>> = {
  dev: 0,
  qa: 1,
  sandbox: 2,
  release: 3,
  prod: 4,
};

export function compareEnvironments(
  a: { kind: string | null; name: string },
  b: { kind: string | null; name: string }
): number {
  return (
    (KIND_ORDER[a.kind ?? ""] ?? 99) - (KIND_ORDER[b.kind ?? ""] ?? 99) ||
    a.name.localeCompare(b.name)
  );
}

// Drop the redundant project-name prefix from an environment's name when it's
// shown under that project (e.g. "CAR Membership P2SK (137)" -> "P2SK (137)").
// Falls back to the full name when nothing would be left.
export function stripProjectPrefix(
  envName: string,
  projectName: string
): string {
  if (
    projectName &&
    envName.toLowerCase().startsWith(projectName.toLowerCase())
  ) {
    const rest = envName.slice(projectName.length).replace(/^[\s:–—-]+/, "");
    return rest.trim() || envName;
  }
  return envName;
}

type Sortable = { projectId: string; kind: string | null; name: string };

/** One project's environments in display order. */
export function environmentsOf<T extends Sortable>(
  envs: readonly T[],
  projectId: string
): T[] {
  return envs
    .filter((e) => e.projectId === projectId)
    .sort(compareEnvironments);
}

/** Environments grouped under their project, in the given project order. */
export function groupEnvironmentsByProject<
  P extends { id: string },
  T extends Sortable,
>(
  projects: readonly P[],
  envs: readonly T[]
): { project: P; environments: T[] }[] {
  return projects
    .map((project) => ({
      project,
      environments: environmentsOf(envs, project.id),
    }))
    .filter((group) => group.environments.length > 0);
}

// Sections that exist identically under every environment. Switching from one
// of these keeps the user on the same section in the target ("show me area X
// for another environment"). backup-restore is deliberately excluded: it's a
// source-specific flow, often mid-operation, so switching drops to the dashboard.
export const PARALLEL_SECTIONS: ReadonlySet<string> = new Set([
  "services",
  "databases",
  "mock-time",
  "mail",
  "issues",
  "history",
  "settings",
]);

// Project permission each gated environment section needs. The sidebar hides
// the same entries with this map, so a switch never lands on a 403.
// `satisfies` keeps the known keys non-optional under noUncheckedIndexedAccess.
export const SECTION_PERMS = {
  "mock-time": { clock: ["control"] },
  mail: { mail: ["read"] },
  settings: { environment: ["update"] },
} satisfies Record<string, ProjectPermissions>;

export type SwitchEnvironment = {
  key: string;
  slug: string;
  hasMailpit: boolean;
};

export function canOpenSection(
  section: string,
  env: { hasMailpit: boolean },
  role: ProjectRole | null
): boolean {
  if (!role) return false;
  if (section === "mail" && !env.hasMailpit) return false;
  const perm: ProjectPermissions | undefined =
    SECTION_PERMS[section as keyof typeof SECTION_PERMS];
  return !perm || canProject(role, perm);
}

/** Where picking `env` in the environment switcher should go. */
export function environmentSwitchHref(
  env: SwitchEnvironment,
  from: NavPath,
  role: ProjectRole | null
): string {
  const base = `/${env.key}/${env.slug}`;
  if (
    from.scope === "env" &&
    from.section &&
    PARALLEL_SECTIONS.has(from.section) &&
    canOpenSection(from.section, env, role)
  ) {
    return `${base}/${from.section}`;
  }
  return base;
}

function latestBy<T>(
  items: readonly T[],
  at: (item: T) => number | undefined
): T | undefined {
  let latest: T | undefined;
  let latestAt = -Infinity;
  for (const item of items) {
    const t = at(item);
    if (t !== undefined && t > latestAt) {
      latest = item;
      latestAt = t;
    }
  }
  return latest;
}

/**
 * Where picking a project in the project switcher should go: the caller's most
 * recently opened environment there (same section when it can), the equivalent
 * project page, or the project overview. Picking the current project goes to
 * its overview, like the plain project crumb this replaced.
 *
 * `visitedAt` (environment id → browser epoch ms) carries visits made since the
 * shell's environment list was loaded: the root layout doesn't re-render on
 * client navigation, so its `lastAccessedAt` goes stale within a session.
 */
export function projectSwitchHref({
  projectKey,
  environments,
  role,
  from,
  visitedAt = {},
}: {
  projectKey: string;
  environments: readonly (SwitchEnvironment & {
    id: string;
    lastAccessedAt: Date | null;
  })[];
  role: ProjectRole | null;
  from: NavPath;
  visitedAt?: Readonly<Record<string, number>>;
}): string {
  const overview = `/${projectKey}`;
  if (from.scope !== null && from.projectKey === projectKey) return overview;
  if (from.scope === "project") {
    return from.page === "settings" && canProject(role, SECTION_PERMS.settings)
      ? `${overview}/settings`
      : overview;
  }
  if (from.scope === "env") {
    // A visit this session is newer than anything the shell loaded, so it
    // wins outright. Each source is only compared within its own clock: the
    // browser's Date.now() and the server's timestamps aren't comparable.
    const latest =
      latestBy(environments, (env) => visitedAt[env.id]) ??
      latestBy(environments, (env) => env.lastAccessedAt?.getTime());
    if (latest) return environmentSwitchHref(latest, from, role);
  }
  return overview;
}
