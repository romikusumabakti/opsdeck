# Project-level navigation — design

Status: direction approved by Romi (2026-11-11); builder-checked. Follows the Releases bug (v0.5.6): `/SCMB/releases` showed "Select environment" and an empty sidebar.

## Why

The Panel has two levels below the org: a **project** (e.g. Sucor Membership, `SCMB`) and its **environments** (e.g. `dev`). The sidebar and header only know the environment level well:

- The sidebar has a group for the active environment, and nothing for the project. A project-level page (`/KEY/releases`, `/KEY/settings`, `/KEY/issues/42`) therefore shows only the global group, and the user loses their place.
- The header shows the environment switcher with the placeholder "Select environment" on every project-level page, as if something were missing.
- Releases sits in the environment group although it is a project page, so clicking it drops the environment context. This is the bug Romi reported, and it also happens on projects that do have releases (CRMB).
- Issues belong to the project (schema: "Issues belong to the LOGICAL project"), yet the list lives at `/KEY/<env>/issues`, where the environment in the URL changes nothing (the page only uses `env.projectId`). The same list also exists as a tab on the project overview. An issue's detail page (`/KEY/issues/42`) is project-level and loses the environment.

The goal is that every page sits clearly at one level, and the navigation shows that level.

## Decisions made with Romi (2026-11-11)

1. **Releases and Issues are project-level.** Their data belongs to the project. The environment is only a note on a row ("tested on", "found in"). "Mark as release" stays on the environment's Deploys page, where the build was proven.
2. **The sidebar gets a project group**, shown both on project pages and inside an environment of that project.
3. **The environment group** keeps only environment pages. Releases and Issues leave it.
4. **The Issues list moves to `/KEY/issues`.** The old `/KEY/<env>/issues` redirects there, so bookmarks keep working.
5. **The breadcrumb on project-level pages** reads `Project / Page`, without the "Select environment" placeholder.
6. **Not in this change:** a per-environment issue filter (none exists today), and the project "Sources" setting (repositories and default branches per project). Sources is the next project, built on the project group this change adds.

## The shape

### Pages (Claude's call: overview tabs become pages)

The project overview's tabs (Environments, Issues, Milestones, Members) duplicate what the project group will offer. To keep one place per thing, the tabs become pages:

| Page | URL | Who sees the entry |
|---|---|---|
| Overview (the environment cards, as the Environments tab today) | `/KEY` | anyone who sees the project |
| Issues | `/KEY/issues` | anyone who sees the project |
| Milestones | `/KEY/milestones` | anyone who sees the project |
| Releases | `/KEY/releases` | `deploy:view`, and only when the project is releasable (v0.5.6 rule) |
| Members | `/KEY/members` | `member:manage` (as the tab today) |
| Settings | `/KEY/settings` | the permission the "Edit project" button uses today |

- Old links redirect: `/KEY?tab=issues` → `/KEY/issues`, `?tab=milestones` → `/KEY/milestones`, `?tab=members` → `/KEY/members`, `/KEY/<env>/issues` → `/KEY/issues` (status/filter search params carried over).
- The overview's header buttons for Releases and Edit project go away (the sidebar carries them). "New environment" stays on the overview.
- `issues`, `members`, `milestones`, `releases`, `settings` are already in `RESERVED_ENV_SLUGS`, so no environment can collide with the new routes.
- Page permissions are enforced by the route, as today (a hidden entry is not a security boundary).

Settled after the builder check *(Claude's calls)*:

- **The overview loses its tab strip.** `/KEY` is the page header (name, client, key badge, "New environment") plus the environment cards. The tab counts go away: Issues keeps its open-issue badge in the sidebar, and Milestones and Members get no count.
- **Each new page is a normal page shell** (`PageHeader` + scroll body), reusing the tab's current body: `IssuesClient` for Issues, the milestones panel for Milestones, and `ProjectMembersClient` for Members. Milestones keeps its own create/edit gating, unchanged.
- **Forbidden pages use the existing guard, `requireProjectRole`** (the same as Settings today), whether reached directly or by redirect:
  - Members needs `member:manage`;
  - Settings needs `environment:update` (the guard in `$projectKey.settings.tsx`; the sidebar entry uses the same predicate).
- **`ProjectPage` gains `issues` (the list), `milestones` and `members`.** `issue` stays for the detail page.
- **The project switcher from a detail page** (`/CRMB/issues/42`) lands on the other project's list (`/SCMB/issues`), not on the same number.
- **Labels:** the project group's item is "Settings" and the environment group's is "Settings" too. The group labels (project name / environment name) tell them apart, as the sidebar already does for groups. The tooltip in collapsed mode says "Project settings" / "Environment settings".
- **The `/KEY/<env>/issues` redirect** carries every search param over unchanged.
- **The open-issue badge** uses `openCounts[projectId]`, which the sidebar already receives for all projects. No new fetch is needed.

### Sidebar

- **Project group:** label = project name. Items in the table's order, each hidden when the caller lacks the permission. Issues carries the open-issue badge the environment group carries today.
- **Environment group:** label = environment name, as today, minus Releases and Issues. It shows only inside an environment.
- Inside an environment both groups show: project first, environment below. On a project page only the project group shows.
- Active state: the project item is active on its own page and below it (`/KEY/issues/42` → Issues). Overview is active only on `/KEY` exactly.

### Header

- On a project-level page: project switcher, then the page name (Issues, Releases…), with no environment switcher. An issue's detail shows `Project / Issues / KEY-42` with Issues linking back to the list *(the exact last crumb is the builder's call)*.
- Inside an environment: unchanged (project switcher / environment switcher / section).
- The project switcher's "same page in another project" rule extends to the new project pages: from `/CRMB/issues` it goes to `/SCMB/issues`. Releases falls back to the overview when the target project is not releasable.

### Command palette

Wherever it lists project or environment sections today, the same split applies: project pages under the project, environment pages under the environment. The builder checks what it lists now and moves Issues/Releases accordingly.

## Non-goals

- Changing what any page shows, beyond moving it.
- An issue filter by environment.
- The project Sources setting.
- Any server-side or data change. This is a pure UI/routing change with no migration.

## For the builder

- Code to read first: `components/app-sidebar.tsx`, `components/header-breadcrumb.tsx`, `components/command-palette.tsx`, `lib/nav-path.ts` (`parseNavPath`, `PROJECT_PAGES`, `projectSwitchHref`), `web/routes/$locale/_app/$projectKey.index.tsx` (the tabs), `$projectKey.$envSlug.issues.tsx`, `$projectKey.releases.tsx`, `$projectKey.settings.tsx`.
- `IssuesClient` already serves both the overview tab and the environment page, so the Issues page reuses it.
- Redirects follow the existing pattern (`$projectKey.$envSlug.backup-database.tsx`).
- Tests: the sidebar and nav-path tests already exist (`tests/app-sidebar.test.tsx`, nav-path tests); extend them for both groups, the active states, the redirects and the switcher rule.
- Left to the builder: component split, i18n keys (English and Indonesian catalogs), the exact detail-page crumb.
