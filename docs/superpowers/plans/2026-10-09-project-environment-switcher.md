# Project / Environment Switcher Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single all-projects environment dropdown in the header with two focused breadcrumb switchers, `[Project ▾] / [Environment ▾]`, and make Ctrl+K group environments by project.

**Architecture:** All URL parsing, ordering and "where does a switch land" rules live in one pure module, `lib/nav-path.ts`, unit-tested with `bun test`. Two small client components (`components/nav/project-switcher.tsx`, `components/nav/environment-switcher.tsx`) render cmdk popovers. `components/header-breadcrumb.tsx` only composes them. The URL stays the single source of truth; the only data change is exposing `lastAccessedAt` from `listEnvironments()`.

**Tech Stack:** Next.js 16 (App Router, RSC), React 19, TypeScript, next-intl 4, shadcn (base-vega) on `@base-ui/react`, cmdk, lucide-react, Tailwind 4, drizzle-orm, Bun test runner, Biome.

**Spec:** `docs/superpowers/specs/2026-10-09-project-environment-switcher-design.md`

## Global Constraints

- No DB migration. No cookie, localStorage or React context for the selection; the URL is the source of truth.
- Order inside switchers is stable: projects by name (server order from `listProjects()`, already `asc(projects.name)`); environments by kind `dev → qa → sandbox → release → prod → (none)`, then `name.localeCompare`.
- MRU (`lastAccessedAt`) is only used to choose the landing environment when switching project.
- No switch may land on a page the user lacks permission for (fall back to the dashboard or `/KEY`).
- Every new UI string goes into all five `messages/*.json` (ar, en, es, id, zh). Indonesian uses "Proyek" for project and keeps "environment" untranslated, matching the existing file.
- RTL-safe: logical utilities only (`ms-`/`me-`/`ps-`/`pe-`), never `ml-`/`mr-`.
- Navigation from the switchers uses `useViewTransitionRouter().push`.
- Commits must NOT contain any `Co-Authored-By: Claude` / Claude attribution trailer.
- Tests run with `bun test`; types with `bun run typecheck`; lint with `bun run lint` (Biome).

## Review Focus

- A stale bookmark with an unknown key or slug (`/NOPE/x`, `/CMEM/deleted-env`) must not crash the header: it renders what it can resolve. Pinned by `parseNavPath` tests (Task 1) and the null-safe lookup in Task 6.
- Switching to an environment without Mailpit while on Mail must land on the dashboard, not an empty Mail page. Pinned in Task 2 (`canOpenSection` / `environmentSwitchHref` tests).
- Switching from a log viewer (`/KEY/env/services/db/logs`) must land on the target's Services page, not a log route that may not exist. Pinned in Task 2.
- Top-level lowercase routes (`/projects`, `/issues`, `/admin/jira`) must never be read as a project. Pinned in Task 1.
- Two projects with identically named environments ("Release") must stay distinguishable and separately selectable in Ctrl+K. Pinned by `groupEnvironmentsByProject` tests (Task 1) and the project-qualified cmdk `value` in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/nav-path.ts` (create) | Pure: `parseNavPath`, `PARALLEL_SECTIONS`, `SECTION_PERMS`, `canOpenSection`, `environmentSwitchHref`, `projectSwitchHref`, `compareEnvironments`, `stripProjectPrefix`, `environmentsOf`, `groupEnvironmentsByProject`, `NavProject` type |
| `tests/nav-path.test.ts` (create) | Unit tests for everything in `lib/nav-path.ts` |
| `lib/db/schema.ts` (modify ~L1267) | `EnvironmentListItem.lastAccessedAt` |
| `actions/environments.ts` (modify ~L142) | select `lastAccessedAt` |
| `components/app-sidebar.tsx` (modify) | use `parseNavPath` + `SECTION_PERMS` |
| `components/projects-overview.tsx`, `app/[locale]/[projectKey]/page.tsx` (modify) | use `compareEnvironments` / `stripProjectPrefix` |
| `components/nav/environment-kind-badge.tsx` (create) | the small uppercase kind pill, shared by switcher and palette |
| `components/nav/project-switcher.tsx` (create) | project popover |
| `components/nav/environment-switcher.tsx` (create) | environment popover |
| `components/header-breadcrumb.tsx` (rewrite) | composition |
| `app/[locale]/layout.tsx` (modify ~L117-122, 202-222) | pass `projects` |
| `components/command-palette.tsx` (modify) | Projects group + grouped environments |
| `messages/{ar,en,es,id,zh}.json` (modify) | new strings |

---

### Task 1: `lib/nav-path.ts` — path parsing, ordering and grouping

**Files:**
- Create: `lib/nav-path.ts`
- Test: `tests/nav-path.test.ts`

**Interfaces:**
- Consumes: `RESERVED_ENV_SLUGS`, `RESERVED_PROJECT_KEYS` from `@/lib/reserved-paths`.
- Produces:
  ```ts
  export type ProjectPage = "overview" | "settings" | "issue" | "new-environment" | "other";
  export type NavPath =
    | { scope: "env"; projectKey: string; envSlug: string; section: string | null; logs: boolean }
    | { scope: "project"; projectKey: string; page: ProjectPage }
    | { scope: null };
  export type NavProject = { id: string; key: string; name: string };
  export function parseNavPath(pathname: string): NavPath;
  export const KIND_ORDER: Readonly<Record<string, number>>;
  export function compareEnvironments(a: { kind: string | null; name: string }, b: { kind: string | null; name: string }): number;
  export function stripProjectPrefix(envName: string, projectName: string): string;
  export function environmentsOf<T extends { projectId: string; kind: string | null; name: string }>(envs: readonly T[], projectId: string): T[];
  export function groupEnvironmentsByProject<P extends { id: string }, T extends { projectId: string; kind: string | null; name: string }>(projects: readonly P[], envs: readonly T[]): { project: P; environments: T[] }[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/nav-path.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  compareEnvironments,
  environmentsOf,
  groupEnvironmentsByProject,
  parseNavPath,
  stripProjectPrefix,
} from "@/lib/nav-path";

// next-intl's usePathname returns the path without the locale prefix, which is
// what every caller passes in.
describe("parseNavPath", () => {
  it.each([
    [
      "/CMEM/prod",
      { scope: "env", projectKey: "CMEM", envSlug: "prod", section: null, logs: false },
    ],
    [
      "/CMEM/prod/services",
      { scope: "env", projectKey: "CMEM", envSlug: "prod", section: "services", logs: false },
    ],
    [
      "/CMEM/prod/services/db/logs",
      { scope: "env", projectKey: "CMEM", envSlug: "prod", section: "services", logs: true },
    ],
    [
      "/CMEM/fee-daily-129/mock-time",
      { scope: "env", projectKey: "CMEM", envSlug: "fee-daily-129", section: "mock-time", logs: false },
    ],
  ])("reads environment path %s", (path, expected) => {
    expect(parseNavPath(path)).toEqual(expected as never);
  });

  it.each([
    ["/CMEM", "overview"],
    ["/CMEM/settings", "settings"],
    ["/CMEM/issues/42", "issue"],
    ["/CMEM/environments/new", "new-environment"],
    ["/CMEM/members", "other"],
    ["/CMEM/milestones", "other"],
    ["/CMEM/new", "other"],
  ])("reads project-level path %s as %s", (path, page) => {
    expect(parseNavPath(path)).toEqual({ scope: "project", projectKey: "CMEM", page } as never);
  });

  it.each([
    "/",
    "/projects",
    "/issues",
    "/admin/jira",
    "/servers/new",
    "/account/change-password",
    "/PROJECTS",
    "/ISSUES/12",
    "/C",
    "/cmem/prod",
    "/CMEM/Prod",
  ])("treats %s as outside any project", (path) => {
    expect(parseNavPath(path)).toEqual({ scope: null });
  });
});

describe("compareEnvironments", () => {
  it("orders by kind (dev, qa, sandbox, release, prod, none), then name", () => {
    const envs = [
      { kind: null, name: "Alpha" },
      { kind: "prod", name: "Prod" },
      { kind: "qa", name: "core2 (QA Wella)" },
      { kind: "dev", name: "core3" },
      { kind: "release", name: "Release" },
      { kind: "qa", name: "core (QA Aisha)" },
      { kind: "sandbox", name: "Sandbox" },
    ];
    expect([...envs].sort(compareEnvironments).map((e) => e.name)).toEqual([
      "core3",
      "core (QA Aisha)",
      "core2 (QA Wella)",
      "Sandbox",
      "Release",
      "Prod",
      "Alpha",
    ]);
  });
});

describe("stripProjectPrefix", () => {
  it.each([
    ["CAR Membership P2SK (137)", "CAR Membership", "P2SK (137)"],
    ["car membership - Release", "CAR Membership", "Release"],
    ["CAR Membership", "CAR Membership", "CAR Membership"],
    ["Fee Daily (129)", "CAR Membership", "Fee Daily (129)"],
    ["Anything", "", "Anything"],
  ])("%s under %s -> %s", (env, project, expected) => {
    expect(stripProjectPrefix(env, project)).toBe(expected);
  });
});

const env = (id: string, projectId: string, name: string, kind: string | null = null) => ({
  id,
  projectId,
  name,
  kind,
});

describe("environmentsOf", () => {
  it("keeps only the project's environments, in kind order", () => {
    const envs = [
      env("1", "a", "Release", "release"),
      env("2", "b", "Other"),
      env("3", "a", "Dev", "dev"),
    ];
    expect(environmentsOf(envs, "a").map((e) => e.id)).toEqual(["3", "1"]);
  });

  it("returns an empty list for a project without environments", () => {
    expect(environmentsOf([env("1", "a", "Dev")], "z")).toEqual([]);
  });
});

describe("groupEnvironmentsByProject", () => {
  const projects = [
    { id: "a", name: "CAR Membership" },
    { id: "b", name: "Common Membership" },
    { id: "c", name: "Empty Project" },
  ];

  it("keeps project order, drops empty projects, sorts each group", () => {
    const envs = [
      env("1", "b", "Release", "release"),
      env("2", "a", "Release", "release"),
      env("3", "a", "Fee Daily", "dev"),
    ];
    const groups = groupEnvironmentsByProject(projects, envs);
    expect(groups.map((g) => g.project.id)).toEqual(["a", "b"]);
    expect(groups[0]?.environments.map((e) => e.id)).toEqual(["3", "2"]);
    // Same-named environments stay in their own project's group.
    expect(groups[1]?.environments.map((e) => e.id)).toEqual(["1"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/nav-path.test.ts`
Expected: FAIL — `Cannot find module '@/lib/nav-path'`.

- [ ] **Step 3: Implement `lib/nav-path.ts`**

```ts
// Where the user is inside the project → environment hierarchy, read from the
// locale-stripped pathname, plus the ordering rules every project/environment
// picker shares. Pure and client-safe: the header switchers, the sidebar and
// the command palette all read the same rules.
// See docs/superpowers/specs/2026-10-09-project-environment-switcher-design.md.

import { RESERVED_ENV_SLUGS, RESERVED_PROJECT_KEYS } from "@/lib/reserved-paths";

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
export function stripProjectPrefix(envName: string, projectName: string): string {
  if (projectName && envName.toLowerCase().startsWith(projectName.toLowerCase())) {
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
  return envs.filter((e) => e.projectId === projectId).sort(compareEnvironments);
}

/** Environments grouped under their project, in the given project order. */
export function groupEnvironmentsByProject<P extends { id: string }, T extends Sortable>(
  projects: readonly P[],
  envs: readonly T[]
): { project: P; environments: T[] }[] {
  return projects
    .map((project) => ({ project, environments: environmentsOf(envs, project.id) }))
    .filter((group) => group.environments.length > 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/nav-path.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Format, lint, commit**

```bash
bunx biome check --write lib/nav-path.ts tests/nav-path.test.ts
git add lib/nav-path.ts tests/nav-path.test.ts
git commit -m "feat(nav): shared path parser and environment ordering"
```

---

### Task 2: switch targets — `canOpenSection`, `environmentSwitchHref`, `projectSwitchHref`

**Files:**
- Modify: `lib/nav-path.ts`
- Test: `tests/nav-path.test.ts`

**Interfaces:**
- Consumes: `NavPath`, `parseNavPath` (Task 1); `canProject`, `ProjectPermissions`, `ProjectRole` from `@/lib/permissions`.
- Produces:
  ```ts
  export const PARALLEL_SECTIONS: ReadonlySet<string>;
  export const SECTION_PERMS: { "mock-time": ProjectPermissions; mail: ProjectPermissions; settings: ProjectPermissions }; // via `satisfies`
  export type SwitchEnvironment = { key: string; slug: string; hasMailpit: boolean };
  export function canOpenSection(section: string, env: { hasMailpit: boolean }, role: ProjectRole | null): boolean;
  export function environmentSwitchHref(env: SwitchEnvironment, from: NavPath, role: ProjectRole | null): string;
  export function projectSwitchHref(args: {
    projectKey: string;
    environments: readonly (SwitchEnvironment & { lastAccessedAt: Date | null })[];
    role: ProjectRole | null;
    from: NavPath;
  }): string;
  ```

Role facts used by the tests (verified in `lib/permissions.ts`): `viewer` holds only `project:read` and `service:logs` (no `mail:read`, `clock:control` or `environment:update`); `maintainer` holds every project-scoped statement.

- [ ] **Step 1: Write the failing tests**

Append to `tests/nav-path.test.ts` (add the new names to the existing import from `@/lib/nav-path`):

```ts
import {
  canOpenSection,
  environmentSwitchHref,
  projectSwitchHref,
} from "@/lib/nav-path";

const target = (slug: string, lastAccessedAt: Date | null, hasMailpit = true) => ({
  key: "SUCOR",
  slug,
  hasMailpit,
  lastAccessedAt,
});

describe("canOpenSection", () => {
  it("needs a connected Mailpit for mail", () => {
    expect(canOpenSection("mail", { hasMailpit: false }, "maintainer")).toBe(false);
    expect(canOpenSection("mail", { hasMailpit: true }, "maintainer")).toBe(true);
  });
  it("checks the section permission against the role", () => {
    expect(canOpenSection("settings", { hasMailpit: true }, "viewer")).toBe(false);
    expect(canOpenSection("settings", { hasMailpit: true }, "maintainer")).toBe(true);
  });
  it("allows ungated sections for any member", () => {
    expect(canOpenSection("services", { hasMailpit: false }, "viewer")).toBe(true);
  });
  it("denies everything without a role", () => {
    expect(canOpenSection("settings", { hasMailpit: true }, null)).toBe(false);
  });
});

describe("environmentSwitchHref", () => {
  const dest = { key: "CMEM", slug: "qa", hasMailpit: false };

  it("keeps a parallel section", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/services"), "viewer")
    ).toBe("/CMEM/qa/services");
  });
  it("goes from a log viewer to the target's Services", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/services/db/logs"), "viewer")
    ).toBe("/CMEM/qa/services");
  });
  it("drops non-parallel sections to the dashboard", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/backup-restore"), "maintainer")
    ).toBe("/CMEM/qa");
  });
  it("drops mail when the target has no Mailpit", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/mail"), "maintainer")
    ).toBe("/CMEM/qa");
  });
  it("drops a section the role may not open", () => {
    expect(
      environmentSwitchHref(dest, parseNavPath("/CMEM/prod/settings"), "viewer")
    ).toBe("/CMEM/qa");
  });
  it("lands on the dashboard from a project-level page", () => {
    expect(environmentSwitchHref(dest, parseNavPath("/CMEM/settings"), "maintainer")).toBe(
      "/CMEM/qa"
    );
  });
});

describe("projectSwitchHref", () => {
  const environments = [
    target("old", new Date("2026-10-01T00:00:00Z")),
    target("never", null),
    target("latest", new Date("2026-10-08T00:00:00Z")),
  ];

  it("lands on the most recently opened environment, same section", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "viewer",
        from: parseNavPath("/CMEM/prod/services"),
      })
    ).toBe("/SUCOR/latest/services");
  });
  it("uses the landing environment's dashboard for a non-parallel section", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "maintainer",
        from: parseNavPath("/CMEM/prod/backup-restore"),
      })
    ).toBe("/SUCOR/latest");
  });
  it("falls back to the overview when no environment was ever opened", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments: [target("never", null)],
        role: "viewer",
        from: parseNavPath("/CMEM/prod/services"),
      })
    ).toBe("/SUCOR");
  });
  it("falls back to the overview for a project without environments", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments: [],
        role: "viewer",
        from: parseNavPath("/CMEM/prod"),
      })
    ).toBe("/SUCOR");
  });
  it("keeps project settings when permitted", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "maintainer",
        from: parseNavPath("/CMEM/settings"),
      })
    ).toBe("/SUCOR/settings");
  });
  it("drops project settings to the overview when not permitted", () => {
    expect(
      projectSwitchHref({
        projectKey: "SUCOR",
        environments,
        role: "viewer",
        from: parseNavPath("/CMEM/settings"),
      })
    ).toBe("/SUCOR");
  });
  it.each(["/CMEM", "/CMEM/issues/42", "/CMEM/environments/new"])(
    "goes from %s to the overview",
    (path) => {
      expect(
        projectSwitchHref({
          projectKey: "SUCOR",
          environments,
          role: "maintainer",
          from: parseNavPath(path),
        })
      ).toBe("/SUCOR");
    }
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/nav-path.test.ts`
Expected: FAIL — `canOpenSection` / `environmentSwitchHref` / `projectSwitchHref` not exported.

- [ ] **Step 3: Implement**

Add to `lib/nav-path.ts` (import at top: `import { canProject, type ProjectPermissions, type ProjectRole } from "@/lib/permissions";`):

```ts
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

export type SwitchEnvironment = { key: string; slug: string; hasMailpit: boolean };

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

/**
 * Where picking a project in the project switcher should go: the caller's most
 * recently opened environment there (same section when it can), the equivalent
 * project page, or the project overview.
 */
export function projectSwitchHref({
  projectKey,
  environments,
  role,
  from,
}: {
  projectKey: string;
  environments: readonly (SwitchEnvironment & { lastAccessedAt: Date | null })[];
  role: ProjectRole | null;
  from: NavPath;
}): string {
  const overview = `/${projectKey}`;
  if (from.scope === "project") {
    return from.page === "settings" && canProject(role, SECTION_PERMS.settings)
      ? `${overview}/settings`
      : overview;
  }
  if (from.scope === "env") {
    let latest: (typeof environments)[number] | undefined;
    for (const env of environments) {
      if (
        env.lastAccessedAt &&
        (!latest?.lastAccessedAt ||
          env.lastAccessedAt.getTime() > latest.lastAccessedAt.getTime())
      ) {
        latest = env;
      }
    }
    if (latest) return environmentSwitchHref(latest, from, role);
  }
  return overview;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/nav-path.test.ts`
Expected: PASS (all, including Task 1's).

- [ ] **Step 5: Format, lint, commit**

```bash
bunx biome check --write lib/nav-path.ts tests/nav-path.test.ts
git add lib/nav-path.ts tests/nav-path.test.ts
git commit -m "feat(nav): project and environment switch targets"
```

---

### Task 3: expose `lastAccessedAt` and adopt the shared helpers in existing views

Behaviour-preserving refactor: the sidebar, Projects page and project overview read the shared module instead of their local copies, and `listEnvironments()` exposes the recency timestamp it already joins.

**Files:**
- Modify: `lib/db/schema.ts` (~L1262-1270, `EnvironmentListItem`)
- Modify: `actions/environments.ts` (~L142-151, `listEnvironments` select)
- Modify: `components/app-sidebar.tsx` (L59-89 constants, L153-157 active env)
- Modify: `components/projects-overview.tsx` (L40-48 `KIND_ORDER`, L227-231 sort)
- Modify: `app/[locale]/[projectKey]/page.tsx` (L30-37 `stripPrefix`, L191 call)

**Interfaces:**
- Consumes: `parseNavPath`, `SECTION_PERMS`, `compareEnvironments`, `stripProjectPrefix` (Tasks 1-2).
- Produces: `EnvironmentListItem` now has `lastAccessedAt: Date | null`.

- [ ] **Step 1: Add the field to the type**

In `lib/db/schema.ts` replace the `EnvironmentListItem` declaration and its comment:

```ts
// An environment summary plus its owning project's issue key, for readable-URL
// link builders (/[key]/[slug]/…), whether a Mailpit is connected (drives the
// sidebar's Mail entry), and when the current user last opened it (null when
// never; picks the landing environment when switching project). Credential-free.
export type EnvironmentListItem = EnvironmentSummary & {
  key: string;
  hasMailpit: boolean;
  lastAccessedAt: Date | null;
};
```

- [ ] **Step 2: Select it in `listEnvironments()`**

In `actions/environments.ts`, inside the `.select({...})` of `listEnvironments`, after the `hasMailpit` entry add:

```ts
        // Already left-joined for the ordering below; null = never opened.
        lastAccessedAt: environmentAccess.lastAccessedAt,
```

- [ ] **Step 3: Sidebar uses the shared parser and permission map**

In `components/app-sidebar.tsx`:
- Delete the `ENV_PATH_REGEX` constant and its comment (L59-61).
- Add `import { parseNavPath, SECTION_PERMS } from "@/lib/nav-path";`.
- In `projectItems`, replace the three inline `perm` values:
  ```ts
  { key: "mockTime", url: "/mock-time", icon: Clock, perm: SECTION_PERMS["mock-time"] },
  { key: "mail", url: "/mail", icon: Mail, perm: SECTION_PERMS.mail },
  ...
  { key: "settings", url: "/settings", icon: Settings, perm: SECTION_PERMS.settings },
  ```
- Replace the active-env lookup (L153-157):
  ```ts
  const nav = parseNavPath(pathname);
  const activeEnv =
    nav.scope === "env"
      ? (environments.find(
          (e) => e.key === nav.projectKey && e.slug === nav.envSlug
        ) ?? null)
      : null;
  ```

- [ ] **Step 4: Projects page and project overview use the shared helpers**

In `components/projects-overview.tsx`: delete the local `KIND_ORDER` constant and its comment (L40-48), add `import { compareEnvironments } from "@/lib/nav-path";`, and replace the sort (L227-231) with:

```ts
  const environments = [...project.environments].sort(compareEnvironments);
```

Then `grep -n KIND_ORDER components/projects-overview.tsx` must print nothing.

In `app/[locale]/[projectKey]/page.tsx`: delete the local `stripPrefix` function and its comment (L30-37), add `import { stripProjectPrefix } from "@/lib/nav-path";`, and change the call at ~L191 to `stripProjectPrefix(env.name, project.name)`.

- [ ] **Step 5: Verify nothing regressed**

Run: `bun run typecheck && bun test && bun run lint`
Expected: typecheck clean, all tests pass, no lint errors.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write lib/db/schema.ts actions/environments.ts components/app-sidebar.tsx components/projects-overview.tsx "app/[locale]/[projectKey]/page.tsx"
git add lib/db/schema.ts actions/environments.ts components/app-sidebar.tsx components/projects-overview.tsx "app/[locale]/[projectKey]/page.tsx"
git commit -m "refactor(nav): share path parsing and environment order across views"
```

---

### Task 4: i18n strings

**Files:**
- Modify: `messages/en.json`, `messages/id.json`, `messages/es.json`, `messages/ar.json`, `messages/zh.json`

**Interfaces:**
- Produces: `header.searchProject`, `header.noProject`, `header.allProjects`, `header.selectEnvironment`, `header.noEnvironmentInProject`, `header.switchProject` (`{name}`), `header.switchEnvironment` (`{name}`), `commandPalette.projects`.

- [ ] **Step 1: Add the keys with a script**

Run from the repo root (keeps each file's key order and 2-space formatting):

```bash
bun -e '
const add = {
  en: { header: { searchProject: "Search project…", noProject: "No project found.", allProjects: "All projects", selectEnvironment: "Select environment", noEnvironmentInProject: "No environments in this project yet.", switchProject: "Switch project, current: {name}", switchEnvironment: "Switch environment, current: {name}" }, commandPalette: { projects: "Projects" } },
  id: { header: { searchProject: "Cari proyek…", noProject: "Proyek tidak ditemukan.", allProjects: "Semua proyek", selectEnvironment: "Pilih environment", noEnvironmentInProject: "Belum ada environment di proyek ini.", switchProject: "Ganti proyek, saat ini: {name}", switchEnvironment: "Ganti environment, saat ini: {name}" }, commandPalette: { projects: "Proyek" } },
  es: { header: { searchProject: "Buscar proyecto…", noProject: "No se encontró ningún proyecto.", allProjects: "Todos los proyectos", selectEnvironment: "Seleccionar entorno", noEnvironmentInProject: "Este proyecto aún no tiene entornos.", switchProject: "Cambiar proyecto, actual: {name}", switchEnvironment: "Cambiar entorno, actual: {name}" }, commandPalette: { projects: "Proyectos" } },
  ar: { header: { searchProject: "ابحث عن مشروع…", noProject: "لم يتم العثور على مشروع.", allProjects: "كل المشاريع", selectEnvironment: "اختر بيئة", noEnvironmentInProject: "لا توجد بيئات في هذا المشروع بعد.", switchProject: "تبديل المشروع، الحالي: {name}", switchEnvironment: "تبديل البيئة، الحالية: {name}" }, commandPalette: { projects: "المشاريع" } },
  zh: { header: { searchProject: "搜索项目…", noProject: "未找到项目。", allProjects: "所有项目", selectEnvironment: "选择环境", noEnvironmentInProject: "此项目还没有环境。", switchProject: "切换项目，当前：{name}", switchEnvironment: "切换环境，当前：{name}" }, commandPalette: { projects: "项目" } },
};
for (const [loc, ns] of Object.entries(add)) {
  const file = `messages/${loc}.json`;
  const json = JSON.parse(await Bun.file(file).text());
  for (const [n, keys] of Object.entries(ns)) Object.assign(json[n], keys);
  await Bun.write(file, JSON.stringify(json, null, 2) + "\n");
}
'
```

- [ ] **Step 2: Verify**

Run: `git diff --stat messages/` — expect only the five files with ~8 added lines each and no removals.
Run: `bun -e 'for (const l of ["ar","en","es","id","zh"]) { const j = JSON.parse(await Bun.file(`messages/${l}.json`).text()); console.log(l, j.header.switchProject, "|", j.commandPalette.projects); }'` — every locale prints a value.

If `git diff` shows unrelated reformatting (e.g. the original file had no trailing newline), revert with `git checkout messages/` and add the keys by hand with Edit instead.

- [ ] **Step 3: Commit**

```bash
git add messages/
git commit -m "feat(nav): switcher strings in all locales"
```

---

### Task 5: switcher components

**Files:**
- Create: `components/nav/environment-kind-badge.tsx`
- Create: `components/nav/project-switcher.tsx`
- Create: `components/nav/environment-switcher.tsx`

**Interfaces:**
- Consumes: `NavProject`, `stripProjectPrefix` (Task 1); i18n keys (Task 4); `EnvironmentListItem` (Task 3); existing `ProjectCreateDialog` (`@/components/project-create-dialog`, props `open`, `onOpenChange`, `onCreated`).
- Produces:
  ```tsx
  export function EnvironmentKindBadge({ kind }: { kind: EnvironmentListItem["kind"] }): JSX.Element | null;
  export function ProjectSwitcher(props: {
    projects: readonly NavProject[];
    activeProject: NavProject;
    canCreateProject: boolean;
    onSelect: (project: NavProject) => void;
  }): JSX.Element;
  export function EnvironmentSwitcher(props: {
    environments: readonly EnvironmentListItem[]; // the active project's, already in display order
    activeEnvironment: EnvironmentListItem | null;
    projectName: string;
    createHref: string | null;
    onSelect: (env: EnvironmentListItem) => void;
  }): JSX.Element;
  ```

These are presentational client components; their list logic is the already-tested `environmentsOf` (callers pass the result). Verification is typecheck + lint here and the manual check in Task 8.

- [ ] **Step 1: Kind badge**

`components/nav/environment-kind-badge.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import type { EnvironmentListItem } from "@/lib/db/schema";

// The small uppercase pill marking an environment's purpose (DEV, QA, …) in
// pickers. Renders nothing for environments without a kind.
export function EnvironmentKindBadge({
  kind,
}: {
  kind: EnvironmentListItem["kind"];
}) {
  const t = useTranslations("environmentKinds");
  if (!kind) return null;
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {t(kind)}
    </span>
  );
}
```

- [ ] **Step 2: Project switcher**

`components/nav/project-switcher.tsx`:

```tsx
"use client";

import { Check, ChevronDown, FolderKanban, FolderPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRouter } from "@/i18n/navigation";
import type { NavProject } from "@/lib/nav-path";
import { cn } from "@/lib/utils";

export function ProjectSwitcher({
  projects,
  activeProject,
  canCreateProject,
  onSelect,
}: {
  projects: readonly NavProject[];
  activeProject: NavProject;
  canCreateProject: boolean;
  onSelect: (project: NavProject) => void;
}) {
  const t = useTranslations("header");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  function select(project: NavProject) {
    setOpen(false);
    if (project.id !== activeProject.id) onSelect(project);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label={t("switchProject", { name: activeProject.name })}
            className="gap-1.5 h-8 px-2 font-medium min-w-0"
          />
        }
      >
        <span className="truncate max-w-[120px] sm:max-w-[220px]">
          {activeProject.name}
        </span>
        <ChevronDown className="size-3.5 opacity-60 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={t("searchProject")} className="h-9" />
          <CommandList>
            <CommandEmpty>{t("noProject")}</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  // Name and key, so typing either finds the project.
                  value={`${project.name} ${project.key}`}
                  onSelect={() => select(project)}
                >
                  <span className="flex-1 min-w-0 truncate">{project.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {project.key}
                  </span>
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      project.id === activeProject.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__all-projects"
                onSelect={() => {
                  setOpen(false);
                  router.push("/projects");
                }}
              >
                <FolderKanban className="size-4" />
                {t("allProjects")}
              </CommandItem>
              {canCreateProject && (
                <CommandItem
                  value="__create-project"
                  onSelect={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <FolderPlus className="size-4" />
                  {t("createProject")}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>

      <ProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />
    </Popover>
  );
}
```

- [ ] **Step 3: Environment switcher**

`components/nav/environment-switcher.tsx`:

```tsx
"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { EnvironmentKindBadge } from "@/components/nav/environment-kind-badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRouter } from "@/i18n/navigation";
import type { EnvironmentListItem } from "@/lib/db/schema";
import { stripProjectPrefix } from "@/lib/nav-path";
import { cn } from "@/lib/utils";

export function EnvironmentSwitcher({
  environments,
  activeEnvironment,
  projectName,
  createHref,
  onSelect,
}: {
  // The active project's environments, already in display order.
  environments: readonly EnvironmentListItem[];
  // Null on project-level pages: the trigger shows a placeholder.
  activeEnvironment: EnvironmentListItem | null;
  projectName: string;
  createHref: string | null;
  onSelect: (env: EnvironmentListItem) => void;
}) {
  const t = useTranslations("header");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  function select(env: EnvironmentListItem) {
    setOpen(false);
    if (env.id !== activeEnvironment?.id) onSelect(env);
  }

  const activeLabel = activeEnvironment
    ? stripProjectPrefix(activeEnvironment.name, projectName)
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label={
              activeLabel
                ? t("switchEnvironment", { name: activeLabel })
                : t("selectEnvironment")
            }
            className="gap-1.5 h-8 px-2 font-medium min-w-0"
          />
        }
      >
        {activeEnvironment ? (
          <>
            <span className="truncate max-w-[160px] sm:max-w-[300px]">
              {activeLabel}
            </span>
            <EnvironmentKindBadge kind={activeEnvironment.kind} />
          </>
        ) : (
          <span className="truncate text-muted-foreground">
            {t("selectEnvironment")}
          </span>
        )}
        <ChevronDown className="size-3.5 opacity-60 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          {environments.length > 0 && (
            <CommandInput placeholder={t("searchEnvironment")} className="h-9" />
          )}
          <CommandList>
            {environments.length > 0 ? (
              <>
                <CommandEmpty>{t("noEnvironment")}</CommandEmpty>
                <CommandGroup>
                  {environments.map((env) => (
                    <CommandItem
                      key={env.id}
                      value={`${env.name} ${env.slug}`}
                      onSelect={() => select(env)}
                    >
                      <span className="flex-1 min-w-0 truncate">
                        {stripProjectPrefix(env.name, projectName)}
                      </span>
                      <EnvironmentKindBadge kind={env.kind} />
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          env.id === activeEnvironment?.id
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("noEnvironmentInProject")}
              </p>
            )}
            {createHref && (
              <>
                {environments.length > 0 && <CommandSeparator />}
                <CommandGroup>
                  <CommandItem
                    value="__create-environment"
                    onSelect={() => {
                      setOpen(false);
                      router.push(createHref);
                    }}
                  >
                    <Plus className="size-4" />
                    {t("createEnvironment")}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Verify**

Run: `bunx biome check --write components/nav && bun run typecheck && bun run lint`
Expected: clean. (Components are not mounted yet; that is Task 6.)

- [ ] **Step 5: Commit**

```bash
git add components/nav
git commit -m "feat(nav): project and environment switcher components"
```

---

### Task 6: rebuild `HeaderBreadcrumb` and wire the layout

**Files:**
- Modify (rewrite): `components/header-breadcrumb.tsx`
- Modify: `app/[locale]/layout.tsx` (L117-122 maps, L202-208 `<HeaderBreadcrumb>` props)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `HeaderBreadcrumb({ environments, projects, orgRole, projectRoles })` where `projects: readonly NavProject[]`. Task 7 also needs the layout's `navProjects` variable.

- [ ] **Step 1: Replace `components/header-breadcrumb.tsx` entirely**

Keep `getStaticSegments`, `getEnvironmentSubKey`, `Slash`, `StaticCrumb` exactly as they are today (copy them across unchanged). Remove `stripProjectPrefix`, the three regexes, `PARALLEL_SECTIONS` and the old `EnvironmentSwitcher` (all moved). The new file:

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { EnvironmentSwitcher } from "@/components/nav/environment-switcher";
import { ProjectSwitcher } from "@/components/nav/project-switcher";
import { Separator } from "@/components/ui/separator";
import { useViewTransitionRouter } from "@/hooks/use-view-transition-router";
import { Link, usePathname } from "@/i18n/navigation";
import type { EnvironmentListItem } from "@/lib/db/schema";
import {
  environmentSwitchHref,
  environmentsOf,
  type NavPath,
  type NavProject,
  parseNavPath,
  projectSwitchHref,
} from "@/lib/nav-path";
import {
  canCreateEnvironment,
  canOrg,
  type OrgRole,
  type ProjectRole,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

type StaticSegment = {
  kind: "static";
  href?: string;
  // Either an i18n key or, for data-driven crumbs, the literal label to render.
  labelKey?: string;
  label?: string;
};

// ← paste getStaticSegments(pathname) here, unchanged from the old file.

// ← paste getEnvironmentSubKey(slug) here, unchanged from the old file.

// Crumbs after the switchers: the environment section (or Services / Logs), or
// the project-level page's own name.
function getTrailingSegments(
  nav: NavPath,
  activeEnv: EnvironmentListItem | null
): StaticSegment[] {
  if (nav.scope === "env" && activeEnv) {
    if (nav.logs) {
      // Services is a real landing page, so make it a link; Logs is current.
      return [
        {
          kind: "static",
          href: `/${activeEnv.key}/${activeEnv.slug}/services`,
          labelKey: "breadcrumbs.services",
        },
        { kind: "static", labelKey: "breadcrumbs.logs" },
      ];
    }
    const subKey = getEnvironmentSubKey(nav.section ?? undefined);
    return subKey ? [{ kind: "static", labelKey: subKey }] : [];
  }
  if (nav.scope === "project") {
    switch (nav.page) {
      case "settings":
        return [{ kind: "static", labelKey: "breadcrumbs.settings" }];
      case "issue":
        return [{ kind: "static", labelKey: "breadcrumbs.issues" }];
      case "new-environment":
        return [{ kind: "static", labelKey: "breadcrumbs.newEnvironment" }];
      default:
        return [];
    }
  }
  return [];
}

// ← paste Slash() and StaticCrumb() here, unchanged from the old file.

export function HeaderBreadcrumb({
  environments,
  projects,
  orgRole,
  projectRoles,
}: {
  environments: EnvironmentListItem[];
  projects: readonly NavProject[];
  orgRole: OrgRole;
  projectRoles: Record<string, ProjectRole>;
}) {
  const pathname = usePathname();
  const t = useTranslations();
  // View Transitions give a switch a perceptible crossfade so it doesn't look
  // like an instant context wipe.
  const router = useViewTransitionRouter();

  const nav = parseNavPath(pathname);
  // An unknown key (stale bookmark, revoked access) resolves to no project: the
  // page itself 404s, the header just falls back to static crumbs.
  const activeProject =
    nav.scope === null
      ? null
      : (projects.find((p) => p.key === nav.projectKey) ?? null);
  const projectEnvs = React.useMemo(
    () => (activeProject ? environmentsOf(environments, activeProject.id) : []),
    [environments, activeProject]
  );
  const activeEnv =
    nav.scope === "env"
      ? (projectEnvs.find((e) => e.slug === nav.envSlug) ?? null)
      : null;

  if (!activeProject) {
    const segments = getStaticSegments(pathname);
    if (segments.length === 0) return null;
    return (
      <Crumbs>
        {segments.map((seg, i) => (
          <React.Fragment key={`${seg.labelKey ?? seg.label}-${i}`}>
            {i > 0 && <Slash />}
            <StaticCrumb
              href={seg.href}
              label={seg.label ?? t(seg.labelKey as never)}
              isLast={i === segments.length - 1}
            />
          </React.Fragment>
        ))}
      </Crumbs>
    );
  }

  const role = projectRoles[activeProject.id] ?? null;
  const trailing = getTrailingSegments(nav, activeEnv);

  return (
    <Crumbs>
      <ProjectSwitcher
        projects={projects}
        activeProject={activeProject}
        canCreateProject={canOrg(orgRole, { project: ["create"] })}
        onSelect={(project) =>
          router.push(
            projectSwitchHref({
              projectKey: project.key,
              environments: environments.filter((e) => e.projectId === project.id),
              role: projectRoles[project.id] ?? null,
              from: nav,
            })
          )
        }
      />
      <Slash />
      <EnvironmentSwitcher
        environments={projectEnvs}
        activeEnvironment={activeEnv}
        projectName={activeProject.name}
        createHref={
          canCreateEnvironment(orgRole, role)
            ? `/${activeProject.key}/environments/new`
            : null
        }
        onSelect={(env) => router.push(environmentSwitchHref(env, nav, role))}
      />
      {trailing.map((seg, i) => (
        <React.Fragment key={`${seg.labelKey ?? seg.label}-${i}`}>
          <Slash />
          <StaticCrumb
            href={seg.href}
            label={seg.label ?? t(seg.labelKey as never)}
            isLast={i === trailing.length - 1}
          />
        </React.Fragment>
      ))}
    </Crumbs>
  );
}

function Crumbs({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Separator orientation="vertical" className="h-5 data-vertical:self-center" />
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
        {children}
      </nav>
    </>
  );
}
```

`Link` and `cn` are used by the pasted `StaticCrumb`; keep those imports.

- [ ] **Step 2: Wire the layout**

In `app/[locale]/layout.tsx` replace the two maps (L117-122):

```ts
  // Slim projection for the client-side pickers (header switchers, palette).
  const navProjects = projects.map(({ id, key, name }) => ({ id, key, name }));
```

and the `<HeaderBreadcrumb>` element:

```tsx
                          <HeaderBreadcrumb
                            environments={environments}
                            projects={navProjects}
                            orgRole={orgRole}
                            projectRoles={projectRoles}
                          />
```

- [ ] **Step 3: Verify**

Run: `bunx biome check --write components/header-breadcrumb.tsx "app/[locale]/layout.tsx" && bun run typecheck && bun test && bun run lint`
Expected: all clean. `grep -rn "projectNameById\|projectKeyById" app components` prints nothing.

- [ ] **Step 4: Commit**

```bash
git add components/header-breadcrumb.tsx "app/[locale]/layout.tsx"
git commit -m "feat(nav): split header breadcrumb into project and environment switchers"
```

---

### Task 7: command palette — Projects group and grouped environments

**Files:**
- Modify: `components/command-palette.tsx`
- Modify: `app/[locale]/layout.tsx` (the `<CommandPalette>` element, ~L218-222)

**Interfaces:**
- Consumes: `groupEnvironmentsByProject`, `stripProjectPrefix`, `NavProject` (Task 1); `EnvironmentKindBadge` (Task 5); `commandPalette.projects` (Task 4); `navProjects` (Task 6).
- Produces: `CommandPalette({ environments, projects, orgRole, projectRoles })`.

- [ ] **Step 1: Props and grouping**

In `components/command-palette.tsx`:
- Change `import { useEffect, useState } from "react";` to `import { Fragment, useEffect, useMemo, useState } from "react";`.
- Add imports: `import { EnvironmentKindBadge } from "@/components/nav/environment-kind-badge";` and `import { groupEnvironmentsByProject, type NavProject, stripProjectPrefix } from "@/lib/nav-path";`.
- Add `projects` to the props: `projects: readonly NavProject[];` (type) and destructure it.
- After the `canCreateEnvironment` constant add:
  ```ts
  const environmentGroups = useMemo(
    () => groupEnvironmentsByProject(projects, environments),
    [projects, environments]
  );
  ```

- [ ] **Step 2: Replace the flat Environments group**

Replace the whole `{environments.length > 0 && ( … )}` block with:

```tsx
          {projects.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading={t("projects")}>
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={`project ${project.name} ${project.key}`}
                    onSelect={() => run(() => router.push(`/${project.key}`))}
                  >
                    <FolderKanban />
                    <span className="truncate">{project.name}</span>
                    <CommandShortcut className="font-mono">
                      {project.key}
                    </CommandShortcut>
                  </CommandItem>
                ))}
                {canCreateEnvironment && (
                  // An environment needs a parent project, so the palette (which
                  // has no project context) sends the user to the list, where
                  // every project card carries the action.
                  <CommandItem
                    value="new environment create"
                    onSelect={() => run(() => router.push("/projects"))}
                  >
                    <Plus />
                    {tHeader("createEnvironment")}
                  </CommandItem>
                )}
              </CommandGroup>
            </>
          )}

          {environmentGroups.map(({ project, environments: envs }) => (
            <Fragment key={project.id}>
              <CommandSeparator />
              <CommandGroup heading={project.name}>
                {envs.map((env) => (
                  <CommandItem
                    key={env.id}
                    // Project-qualified so same-named environments in two
                    // projects stay distinct and searchable by project.
                    value={`environment ${project.name} ${project.key} ${env.name}`}
                    onSelect={() =>
                      run(() => router.push(`/${env.key}/${env.slug}`))
                    }
                  >
                    <Folder />
                    <span className="flex-1 min-w-0 truncate">
                      {stripProjectPrefix(env.name, project.name)}
                    </span>
                    <EnvironmentKindBadge kind={env.kind} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </Fragment>
          ))}
```

If `t("environments")` is no longer referenced, leave the message key in place (harmless; removing it from five files is churn).

- [ ] **Step 3: Wire the layout**

In `app/[locale]/layout.tsx`:

```tsx
                            <CommandPalette
                              environments={environments}
                              projects={navProjects}
                              orgRole={orgRole}
                              projectRoles={projectRoles}
                            />
```

- [ ] **Step 4: Verify**

Run: `bunx biome check --write components/command-palette.tsx "app/[locale]/layout.tsx" && bun run typecheck && bun test && bun run lint`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add components/command-palette.tsx "app/[locale]/layout.tsx"
git commit -m "feat(nav): group environments by project in the command palette"
```

---

### Task 8: verify in the running app

**Files:** none (fix-ups only if something fails, committed as `fix(nav): …`).

- [ ] **Step 1: Full checks**

Run: `bun run typecheck && bun test && bun run lint && bun run build`
Expected: all succeed. Paste failures verbatim if any.

- [ ] **Step 2: Drive the app** (use the `run` skill to start the dev server and a browser)

Check each, logged in as a user with access to at least two projects:

1. On `/{KEY}/{env}/services`: breadcrumb shows `Project ▾ / Env [KIND] ▾ / Services`.
2. Environment switcher lists only that project's environments, in kind order; picking another stays on Services.
3. Project switcher lists all projects alphabetically with keys; picking another lands on the most recently opened environment there, on Services; a never-opened project lands on `/KEY`.
4. On `/{KEY}/settings` (as maintainer): both switchers show, environment shows "Select environment"; switching project keeps Settings; as a viewer-only project it lands on `/KEY`.
5. On `/{KEY}/issues/{n}`: switching project lands on `/KEY`.
6. On `/{KEY}/{env}/services/db/logs`: switching environment lands on Services.
7. On Mail in an env with Mailpit: switching to an env without Mailpit lands on the dashboard.
8. Ctrl+K: Projects group (with keys) and one group per project with kind badges; typing a project name surfaces its environments.
9. Unknown URL `/{KEY}/does-not-exist`: 404 page renders and the header does not crash.
10. Switch locale to `ar`: switchers render right-to-left with translated strings.

- [ ] **Step 3: Report**

State which checks passed and paste any failure with the observed behaviour.
