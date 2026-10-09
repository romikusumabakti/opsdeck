// Where the user is inside the project → environment hierarchy, read from the
// locale-stripped pathname, plus the ordering rules every project/environment
// picker shares. Pure and client-safe: the header switchers, the sidebar and
// the command palette all read the same rules.
// See docs/superpowers/specs/2026-10-09-project-environment-switcher-design.md.

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
