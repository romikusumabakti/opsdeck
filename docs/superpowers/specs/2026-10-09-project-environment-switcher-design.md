# Project / environment switcher rebuild — design

Date: 2026-10-09
Status: approved (brainstorming), pending spec review

## Goal

Rebuild how users pick a project and an environment in the app header so that switching project and switching environment are two separate, focused actions.

## Problems with the current switcher

- **Everything in one list.** `EnvironmentSwitcher` (`components/header-breadcrumb.tsx`) shows every visible environment of every project in one popover, grouped by project. With 8 projects and ~17 environments it is hard to focus on the current project.
- **The project crumb is only a link.** Switching project means opening the environment list and hunting for another project's group, or going through `/projects`.
- **Project-level pages have no switcher.** `/KEY` and `/KEY/settings` render no breadcrumb at all; `/KEY/issues/N` and `/KEY/environments/new` render static crumbs only.
- **Inconsistent order.** Switcher: projects alphabetical, environments MRU. Command palette: flat MRU list. Projects page: environments by kind, then name.
- **Duplicated logic.** The environment path regex lives in both `header-breadcrumb.tsx` and `app-sidebar.tsx`; the project-prefix stripper exists in `header-breadcrumb.tsx` and `app/[locale]/[projectKey]/page.tsx`; `KIND_ORDER` lives only in `projects-overview.tsx`.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Pattern | Two breadcrumb switchers: `[Project ▾] / [Environment ▾]` (Vercel/Supabase/Neon style). Ctrl+K stays the global cross-project search |
| Switching project | Land on the user's most recently opened environment in the target project, keeping the current section when possible; otherwise the project overview |
| Order inside switchers | Stable, not MRU. Projects alphabetical; environments by kind, then name. MRU is only used to pick the landing environment |
| State | URL stays the single source of truth. No cookie, localStorage or context for the selection |
| Schema | No migration |
| Out of scope | Favourites/pins, manual environment ordering, environment status in the switcher, new keyboard shortcuts |

## Behaviour

### Breadcrumb

```
[Sucor Membership ▾]  /  [Server Portal Dev (56.115)  DEV ▾]  /  Services
```

| Page | Breadcrumb |
|---|---|
| Environment pages `/KEY/env[/section…]` | Project switcher / Environment switcher / existing section crumbs (incl. Services / Logs) |
| Project-level pages `/KEY`, `/KEY/settings`, `/KEY/issues/N`, `/KEY/environments/new` | Project switcher / Environment switcher with muted "Select environment" placeholder / existing trailing crumb (Issues, New environment, Settings) |
| Global pages (Home, `/projects`, `/servers`, …) | Unchanged |

### Project switcher

- Trigger: project name (truncated). `aria-label` "Switch project, current: {name}".
- Popover: cmdk search (matches name and key), list of all visible projects sorted by name (`localeCompare`). Each row: name, key in muted mono text, check mark on the active project. Projects with no environments are listed.
- Footer: "All projects" (`/projects`), "New project" (when `canOrg(orgRole, { project: ["create"] })`, opens the existing `ProjectCreateDialog`).
- Selecting the active project goes to its overview `/KEY` (the way back the old project crumb link provided); a no-op when already there.
- Target (see `projectSwitchHref`):
  - **From an environment page:** the target project's environment with the latest `lastAccessedAt`. Keep the current section if it is in `PARALLEL_SECTIONS` and the user's role in the target project has that section's permission (same map the sidebar uses); otherwise that environment's dashboard. If the user never opened an environment in the target project, `/KEY`.
  - **From a project-level page:** `/KEY/settings` → `/NEW/settings` when the target role allows `environment: ["update"]`, else `/NEW`. Every other project-level page (overview, issue detail, new environment) → `/NEW`.

### Environment switcher

- Trigger: environment name with the project prefix stripped, kind badge, chevron. Placeholder "Select environment" (muted) on project-level pages. `aria-label` "Switch environment, current: {name}".
- Popover: cmdk search, only the active project's environments, sorted by `compareEnvironments` (kind order dev → qa → sandbox → release → prod → none, then name). Each row: stripped name, kind badge, check mark.
- Empty project: "No environments in this project yet".
- Footer: "New environment" (`/KEY/environments/new`) when `canCreateEnvironment(orgRole, projectRole)`.
- Selecting the active environment only closes the popover.
- Target (see `environmentSwitchHref`): `/KEY/slug/section` when the current section is in `PARALLEL_SECTIONS`, else `/KEY/slug`. Unchanged from today; from a project-level page it is always the dashboard.

### Command palette (Ctrl+K)

- Environments grouped by project (groups by name, environments by `compareEnvironments`), with kind badge; search value includes project name, key and environment name.
- New "Projects" group: every visible project, selecting it goes to `/KEY`.

## Architecture

### `lib/nav-path.ts` (pure, no React or DB)

- `parseNavPath(pathname): NavPath` where

  ```ts
  type NavPath =
    | { scope: "env"; projectKey: string; envSlug: string; section: string | null; logs: boolean }
    | { scope: "project"; projectKey: string; page: "overview" | "settings" | "issue" | "new-environment" }
    | { scope: null };
  ```

  A second segment in `RESERVED_ENV_SLUGS` (`lib/reserved-paths.ts`) is a project-level page, never an environment. Replaces the regexes in `header-breadcrumb.tsx` (`ENV_PATH_REGEX`, `PROJECT_SUB_PATH_REGEX`, `LOGS_PATH_REGEX`) and `app-sidebar.tsx`.
- `PARALLEL_SECTIONS` moves here unchanged (services, databases, mock-time, mail, issues, history, settings).
- `projectSwitchHref(args)` and `environmentSwitchHref(args)` implement the target rules above. They take plain data (current `NavPath`, target project, its environments with `lastAccessedAt`, the target role, and a `can(section)` predicate) and return a path string.
- `compareEnvironments(a, b)` (kind order, then name) and `stripProjectPrefix(envName, projectName)`.

The section → permission map currently inlined in `app-sidebar.tsx` (`projectItems`) is exported from there or moved next to `PARALLEL_SECTIONS` so both the sidebar and `projectSwitchHref` read the same source.

### Components

- `components/nav/project-switcher.tsx`: client popover + cmdk. Props: `projects`, `activeProjectId`, `onSelect(project)`, `canCreateProject`.
- `components/nav/environment-switcher.tsx`: client popover + cmdk. Props: `environments` (already filtered to the active project), `activeEnvironmentId | null`, `projectName`, `onSelect(env)`, `createHref | null`.
- `components/header-breadcrumb.tsx`: composition only. Calls `parseNavPath`, resolves the active project/environment, computes targets with the `lib/nav-path.ts` helpers, navigates with `useViewTransitionRouter().push`, renders both switchers plus the existing trailing/static crumbs. Fixes project-level pages that currently render nothing.

### Data

- `listEnvironments()` (`actions/environments.ts`) also selects `lastAccessedAt: environmentAccess.lastAccessedAt` (already left-joined for the caller). `EnvironmentListItem` gains `lastAccessedAt: Date | null`. Server order is unchanged.
- `app/[locale]/layout.tsx` passes `projects` (`{ id, key, name }[]`, already fetched by `listProjects()`) to `HeaderBreadcrumb` and `CommandPalette` instead of `projectNameById` / `projectKeyById`.
- `recordEnvironmentAccess` is unchanged; MRU is still bumped by the environment layout.

### Other consumers

- `components/app-sidebar.tsx`: uses `parseNavPath`; behaviour unchanged.
- `components/command-palette.tsx`: grouping, badges and Projects group as above.
- `components/projects-overview.tsx` and `app/[locale]/[projectKey]/page.tsx`: use `compareEnvironments` / `stripProjectPrefix`; behaviour unchanged.

## Edge cases

- **Unknown key/slug in the URL:** the server already 404s; the breadcrumb renders whatever it can resolve and never throws.
- **Target section not allowed in the target project:** fall back to the environment dashboard (environment pages) or `/KEY` (project settings). No switch lands on a 403.
- **Project without environments:** environment switcher shows the empty text and the create action; switching to that project lands on `/KEY`.
- **Long names:** both triggers truncate; the project trigger gets the smaller max width on small screens so the environment name keeps priority.
- **RTL (ar):** logical utilities (`ms-`/`me-`) only.

## i18n

New keys in the `header` namespace, added to all five `messages/*.json` (ar, en, es, id, zh):

- `searchProject`, `noProject`, `allProjects`
- `selectEnvironment`, `noEnvironmentInProject`
- `switchProject`, `switchEnvironment` (aria-labels with a `{name}` argument)

And `commandPalette.projects` (palette group heading).

Reused: `searchEnvironment`, `noEnvironment`, `createEnvironment`, `createProject`, `environmentKinds.*`.

## Testing (`bun test`, TDD)

- `tests/nav-path.test.ts` (main coverage, pure functions):
  - `parseNavPath`: environment root, environment + section, logs, every project-level page, reserved slugs, global pages, locale-less pathnames as returned by next-intl's `usePathname`.
  - `projectSwitchHref`: with and without MRU, parallel vs non-parallel section, section not permitted in target, project settings with and without permission, issue detail and new environment pages, empty project.
  - `environmentSwitchHref`, `compareEnvironments`, `stripProjectPrefix`.
- List shaping is tested through pure helpers (`environmentsOf`, `groupEnvironmentsByProject`) rather than mounted components: the repo has no React testing library, and adding one for two presentational popovers is not worth the dependency.
- Manual check in the running app: switching project from Services, from project settings and from an issue; switching environment; Ctrl+K grouping.
